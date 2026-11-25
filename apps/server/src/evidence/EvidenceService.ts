import {
  EVIDENCE_LIST_PAGE_SIZE,
  EVIDENCE_RECORD_MAX_BYTES,
  EvidenceChangeQa,
  EvidenceError,
  EvidenceLanding,
  EvidenceLandingSummary,
  EvidenceRecord,
  type EvidenceChange,
  type EvidenceCounts,
  type EvidenceReviewThread,
  type EvidenceCoverageInput,
  type EvidenceProjectCoverage,
  type EvidenceGetInput,
  type EvidenceListInput,
  type EvidenceListResult,
  type EvidenceQaState,
  type EvidenceRecordInput,
  type EvidenceRecordResult,
  type EvidenceSetQaInput,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

/** Captures must resolve under ~/evidence. This catches wrong paths; minting a URL needs `filesystem:read`, which is the real boundary. */
const EVIDENCE_ROOT_NAME = "evidence";

export interface RecordInput extends Omit<EvidenceRecordInput, "threadId"> {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}

export class EvidenceService extends Context.Service<
  EvidenceService,
  {
    /** Upserts the agent-written record. QA rows are only ever created here as `pending`. */
    readonly record: (input: RecordInput) => Effect.Effect<EvidenceRecordResult, EvidenceError>;
    readonly list: (input: EvidenceListInput) => Effect.Effect<EvidenceListResult, EvidenceError>;
    readonly get: (input: EvidenceGetInput) => Effect.Effect<EvidenceLanding, EvidenceError>;
    /** The user's QA verdict; agents have no path to it. */
    readonly setQa: (input: EvidenceSetQaInput) => Effect.Effect<EvidenceChangeQa, EvidenceError>;
    readonly counts: () => Effect.Effect<EvidenceCounts, EvidenceError>;
    readonly subscribe: () => Stream.Stream<number>;
    /** Read-only; git runs at most once per project per TTL, and recomputes only when the tip or landings move. */
    readonly coverage: (
      input: EvidenceCoverageInput,
    ) => Effect.Effect<ReadonlyArray<EvidenceProjectCoverage>, EvidenceError>;
  }
>()("t3/evidence/EvidenceService") {}

interface LandingRow {
  readonly landing_id: string;
  readonly thread_id: string;
  readonly project_id: string | null;
  readonly landed_at: string;
  readonly updated_at: string;
  readonly record_json: string;
}
interface QaRow {
  readonly change_id: string;
  readonly state: EvidenceQaState;
  readonly note: string;
  readonly updated_at: string;
}

const RecordJson = Schema.fromJsonString(EvidenceRecord);
const encodeRecord = Schema.encodeEffect(RecordJson);
const decodeRecord = Schema.decodeUnknownEffect(RecordJson);
const decodeLanding = Schema.decodeUnknownEffect(EvidenceLanding);
// json_extract hands back nested values as JSON text.
const decodeSummaryRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...EvidenceLandingSummary.fields,
    target: Schema.fromJsonString(EvidenceLandingSummary.fields.target),
    verifications: Schema.fromJsonString(EvidenceLandingSummary.fields.verifications),
    qa: Schema.fromJsonString(EvidenceLandingSummary.fields.qa),
  }),
);
const decodeQa = Schema.decodeUnknownEffect(EvidenceChangeQa);

const invalid = (message: string) => new EvidenceError({ code: "invalid", message });
const storage = (cause: unknown) =>
  new EvidenceError({ code: "storage", message: "Evidence storage failed.", cause });
const isEvidenceError = Schema.is(EvidenceError);
const passStorage = (error: unknown) => (isEvidenceError(error) ? error : storage(error));

interface CoverageRow {
  readonly project_id: string;
  readonly workspace_root: string;
  readonly thread_id: string;
  readonly landed_at: string;
  readonly branch: string;
  readonly sha: string;
  readonly commits: string;
}
const COVERAGE_TTL_MS = 30_000;

/**
 * First-parent merges (`log` lines: sha, parents, subject; newest first) whose sha, or a commit
 * they brought in, is not in `recorded`. `revs` is `rev-list --parents` over
 * `<oldest merge>^1..tip`; a merge brings in what its later parents reach that neither the
 * first-parent chain nor an older merge already claimed.
 */
function uncoveredMerges(tip: string, log: string, revs: string, recorded: ReadonlySet<string>) {
  const merges = log.split("\n").flatMap((line) => {
    const [sha, parents, subject = ""] = line.split("\x1f");
    return sha && parents ? [{ sha, parents: parents.split(" "), subject }] : [];
  });
  const graph = new Map(
    revs.split("\n").map((line) => {
      const [sha = "", ...parents] = line.trim().split(" ");
      return [sha, parents] as const;
    }),
  );
  const claimed = new Set<string>();
  for (let sha = tip; graph.has(sha); sha = graph.get(sha)![0] ?? "") claimed.add(sha);
  const uncovered = [];
  for (const { parents, ...merge } of merges.toReversed()) {
    let covered = recorded.has(merge.sha);
    const queue = parents.slice(1);
    for (let sha = queue.pop(); sha !== undefined; sha = queue.pop()) {
      if (claimed.has(sha) || !graph.has(sha)) continue;
      claimed.add(sha);
      covered ||= recorded.has(sha);
      queue.push(...graph.get(sha)!);
    }
    if (!covered) uncovered.unshift(merge);
  }
  return uncovered;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const changes = yield* PubSub.sliding<number>(1);
  let revision = 0;
  const publish = Effect.suspend(() => PubSub.publish(changes, ++revision));
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Cleared by record(); entries otherwise live for the TTL, then until the branch tip moves.
  const coverageCache = new Map<
    string,
    { head: string; checkedAt: number; result: EvidenceProjectCoverage | null }
  >();
  // record() bumps this, so a check that read landings before the record never caches its answer.
  let coverageGeneration = 0;
  const coverageLocks = new Map<string, Semaphore.Semaphore>();
  const coverageLock = (projectId: string) => {
    const lock = coverageLocks.get(projectId) ?? Semaphore.makeUnsafe(1);
    coverageLocks.set(projectId, lock);
    return lock;
  };

  const realPath = (target: string) => fileSystem.realPath(target).pipe(Effect.option);

  // Checks run per capture inside the traced record call.
  const checkCapture = Effect.fnUntraced(function* (raw: string, root: string, warnings: string[]) {
    const expanded = expandHomePath(raw, yield* HostProcess.HomeDirectory);
    if (!path.isAbsolute(expanded)) return yield* invalid(`Capture path must be absolute: ${raw}`);
    const resolved = path.resolve(expanded);
    const canonicalRoot = Option.getOrElse(yield* realPath(root), () => root);
    const outside = invalid(`Capture must be under ${root}: ${raw}`);
    if (!isWithinRoot(path, resolved, root) && !isWithinRoot(path, resolved, canonicalRoot))
      return yield* outside;
    const canonical = yield* realPath(resolved);
    if (Option.isNone(canonical)) {
      warnings.push(`capture missing: ${resolved}`);
      return resolved;
    }
    if (!isWithinRoot(path, canonical.value, canonicalRoot)) return yield* outside;
    if (hostPreviewMimeTypeFromExtension(path.extname(canonical.value)) === null)
      warnings.push(`capture not previewable: ${canonical.value}`);
    return canonical.value;
  });

  // The role each of the lead's live local children was delegated with. A deleted child, or one in
  // a linked environment, has no live local thread row, so it never appears here.
  const readChildRoles = Effect.fnUntraced(function* (threadId: ThreadId) {
    const [landing] = yield* sql<{
      readonly relationship: string | null;
      readonly parent_thread_id: string | null;
    }>`SELECT json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
          json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    const leadThreadId =
      landing?.relationship === "subagent" && landing.parent_thread_id !== null
        ? landing.parent_thread_id
        : threadId;
    const rows = yield* sql<{
      readonly child_thread_id: string;
      readonly role: string | null;
    }>`SELECT s.child_thread_id, coalesce(json_extract(t.payload_json, '$.delegateRole'),
            json_extract(s.payload_json, '$.delegateRole')) AS role
        FROM orchestration_v2_projection_subagents s
        JOIN orchestration_v2_projection_threads t ON t.thread_id = s.child_thread_id AND t.deleted_at IS NULL
        WHERE s.thread_id = ${leadThreadId} AND s.origin = 'app_owned'`;
    const roles = new Map<string, Set<string>>();
    for (const row of rows) {
      const known = roles.get(row.child_thread_id) ?? new Set<string>();
      if (row.role !== null) known.add(row.role);
      roles.set(row.child_thread_id, known);
    }
    return roles;
  });

  /**
   * The review as stored: always the agent's claim, unverified. A cited reviewer thread is kept as a
   * link only when it is a review-role child of the same lead; any other is dropped with a warning.
   */
  const storedReview = (
    change: RecordInput["changes"][number],
    childRoles: ReadonlyMap<string, ReadonlySet<string>>,
    warnings: string[],
  ): EvidenceChange["review"] => {
    const { threadId, ...claim } = change.review;
    let review: EvidenceChange["review"] = change.review;
    if (threadId !== undefined) {
      const roles = childRoles.get(threadId);
      if (roles === undefined || !roles.has("review")) {
        warnings.push(
          `change ${change.id}: dropped review.threadId ${threadId} because it ${
            roles === undefined
              ? "is not a thread this lead delegated"
              : "was not delegated with role review"
          }`,
        );
        review = claim;
      }
    }
    return review.verdict === "waived" ? review : { ...review, check: "unverified" };
  };

  const readQa = (landingId: string) =>
    sql<QaRow>`SELECT change_id, state, note, updated_at FROM evidence_qa WHERE landing_id = ${landingId}`;

  const record = Effect.fn("EvidenceService.record")(function* (input: RecordInput) {
    const ids = input.changes.map((change) => change.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) return yield* invalid(`Duplicate change id: ${duplicate}`);
    let landedAt: string | undefined;
    if (input.landedAt !== undefined) {
      const parsed = DateTime.make(input.landedAt);
      if (Option.isNone(parsed)) return yield* invalid(`Invalid landedAt: ${input.landedAt}`);
      landedAt = DateTime.formatIso(parsed.value);
    }
    const root = path.join(yield* HostProcess.HomeDirectory, EVIDENCE_ROOT_NAME);
    const warnings: string[] = [];
    const childRoles = yield* readChildRoles(input.threadId);
    const changes = [];
    for (const change of input.changes) {
      const captures = [];
      for (const capture of change.captures)
        captures.push({ ...capture, path: yield* checkCapture(capture.path, root, warnings) });
      changes.push({ ...change, captures, review: storedReview(change, childRoles, warnings) });
    }
    const recordJson = yield* encodeRecord({
      id: input.id,
      title: input.title,
      target: input.target,
      verifications: input.verifications,
      changes,
    }).pipe(Effect.mapError((cause) => invalid(cause.message)));
    const bytes = new TextEncoder().encode(recordJson).byteLength;
    if (bytes > EVIDENCE_RECORD_MAX_BYTES)
      return yield* invalid(
        `Record is ${bytes} bytes; the limit is ${EVIDENCE_RECORD_MAX_BYTES}. Shorten summaries or gaps.`,
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    const qa = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [owner] = yield* sql<{
            readonly thread_id: string;
          }>`SELECT thread_id FROM evidence_landings WHERE landing_id = ${input.id}`;
          if (owner !== undefined && owner.thread_id !== input.threadId)
            return yield* invalid(
              `Landing id ${input.id} is already used by thread ${owner.thread_id}; pick another id.`,
            );
          yield* sql`INSERT INTO evidence_landings (landing_id, thread_id, project_id, landed_at, record_json, updated_at)
              VALUES (${input.id}, ${input.threadId}, ${input.projectId}, ${landedAt ?? now}, ${recordJson}, ${now})
              ON CONFLICT (landing_id) DO UPDATE SET project_id = excluded.project_id,
              landed_at = coalesce(${landedAt ?? null}, landed_at), record_json = excluded.record_json, updated_at = excluded.updated_at`;
          yield* sql`DELETE FROM evidence_qa WHERE landing_id = ${input.id} AND change_id NOT IN ${sql.in(ids)}`;
          for (const id of ids) {
            yield* sql`INSERT INTO evidence_qa (landing_id, change_id, state, note, updated_at)
                VALUES (${input.id}, ${id}, 'pending', '', ${now}) ON CONFLICT DO NOTHING`;
          }
          return yield* readQa(input.id);
        }),
      )
      .pipe(Effect.mapError(passStorage));
    coverageGeneration++;
    coverageCache.clear();
    const states = new Map(qa.map((row) => [row.change_id, row.state]));
    yield* publish;
    return {
      landingId: input.id,
      changes: ids.map((id) => ({ id, qa: states.get(id) ?? "pending" })),
      warnings,
    };
  }, Effect.mapError(passStorage));

  const list = Effect.fn("EvidenceService.list")(function* (input: EvidenceListInput) {
    let before: { readonly landedAt: string; readonly id: string } | undefined;
    if (input.before !== undefined) {
      const parsed = DateTime.make(input.before.landedAt);
      if (Option.isNone(parsed))
        return yield* invalid(`Invalid cursor landedAt: ${input.before.landedAt}`);
      before = { landedAt: DateTime.formatIso(parsed.value), id: input.before.id };
    }
    // Pick the page through the landed_at indexes first, so JSON and QA tallies run for 21 rows only.
    const rows = yield* sql<{
      readonly id: string;
      readonly title: string;
      readonly thread_id: string;
      readonly project_id: string | null;
      readonly landed_at: string;
      readonly target: string;
      readonly verifications: string;
      readonly change_count: number;
      readonly qa: string;
    }>`WITH page AS (
          SELECT landing_id, thread_id, project_id, landed_at, record_json FROM evidence_landings l
          WHERE ${input.threadId === undefined ? sql`1 = 1` : sql`l.thread_id = ${input.threadId}`}
            AND ${before === undefined ? sql`1 = 1` : sql`(l.landed_at < ${before.landedAt} OR (l.landed_at = ${before.landedAt} AND l.landing_id < ${before.id}))`}
            AND ${input.needsQa === true ? sql`EXISTS (SELECT 1 FROM evidence_qa q WHERE q.landing_id = l.landing_id AND q.state IN ('pending', 'failed'))` : sql`1 = 1`}
          ORDER BY l.landed_at DESC, l.landing_id DESC
          LIMIT ${EVIDENCE_LIST_PAGE_SIZE + 1})
        SELECT p.landing_id AS id, json_extract(p.record_json, '$.title') AS title, p.thread_id, p.project_id, p.landed_at,
          json_extract(p.record_json, '$.target') AS target,
          (SELECT json_group_array(CASE WHEN json_extract(v.value, '$.reason') IS NULL
              THEN json_object('label', json_extract(v.value, '$.label'), 'result', json_extract(v.value, '$.result'))
              ELSE json_object('label', json_extract(v.value, '$.label'), 'result', json_extract(v.value, '$.result'),
                'reason', json_extract(v.value, '$.reason')) END)
            FROM json_each(p.record_json, '$.verifications') v) AS verifications,
          json_array_length(p.record_json, '$.changes') AS change_count,
          (SELECT json_object('pending', count(*) FILTER (WHERE state = 'pending'),
              'confirmed', count(*) FILTER (WHERE state = 'confirmed'),
              'failed', count(*) FILTER (WHERE state = 'failed'), 'waived', count(*) FILTER (WHERE state = 'waived'))
            FROM evidence_qa q WHERE q.landing_id = p.landing_id) AS qa
        FROM page p
        ORDER BY p.landed_at DESC, p.landing_id DESC`;
    const items = yield* Effect.forEach(rows.slice(0, EVIDENCE_LIST_PAGE_SIZE), (row) =>
      decodeSummaryRow({
        id: row.id,
        title: row.title,
        threadId: row.thread_id,
        projectId: row.project_id,
        landedAt: row.landed_at,
        target: row.target,
        verifications: row.verifications,
        changeCount: row.change_count,
        qa: row.qa,
      }),
    );
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > EVIDENCE_LIST_PAGE_SIZE && last !== undefined
          ? { landedAt: last.landedAt, id: last.id }
          : null,
    };
  }, Effect.mapError(passStorage));

  // What each cited reviewer thread is now, in one query for the whole landing.
  const readReviewThreads = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
    const states = new Map<string, EvidenceReviewThread>();
    if (ids.length === 0) return states;
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly archived_at: string | null;
      readonly deleted_at: string | null;
      readonly role: string | null;
    }>`SELECT t.thread_id, t.archived_at, t.deleted_at,
          coalesce(json_extract(t.payload_json, '$.delegateRole'),
            (SELECT json_extract(s.payload_json, '$.delegateRole')
              FROM orchestration_v2_projection_subagents s
              WHERE s.child_thread_id = t.thread_id
                AND json_extract(s.payload_json, '$.delegateRole') IS NOT NULL
              LIMIT 1)) AS role
        FROM orchestration_v2_projection_threads t WHERE t.thread_id IN ${sql.in(ids)}`;
    for (const row of rows)
      states.set(
        row.thread_id,
        row.deleted_at !== null
          ? "missing"
          : row.archived_at !== null
            ? "archived"
            : row.role === "review"
              ? "reviewer"
              : "other",
      );
    return states;
  });

  const get = Effect.fn("EvidenceService.get")(function* (input: EvidenceGetInput) {
    const [row] =
      yield* sql<LandingRow>`SELECT * FROM evidence_landings WHERE landing_id = ${input.landingId}`;
    if (row === undefined)
      return yield* new EvidenceError({
        code: "not_found",
        message: `No evidence landing ${input.landingId}.`,
      });
    const stored = yield* decodeRecord(row.record_json);
    const qa = new Map((yield* readQa(row.landing_id)).map((q) => [q.change_id, q]));
    const cited = stored.changes.flatMap((change) =>
      change.review.threadId === undefined ? [] : [change.review.threadId],
    );
    const threads = yield* readReviewThreads([...new Set(cited)]);
    return yield* decodeLanding({
      ...stored,
      threadId: row.thread_id,
      projectId: row.project_id,
      landedAt: row.landed_at,
      updatedAt: row.updated_at,
      changes: stored.changes.map((change) => {
        const state = qa.get(change.id);
        const threadId = change.review.threadId;
        return {
          ...change,
          review:
            threadId === undefined
              ? change.review
              : { ...change.review, thread: threads.get(threadId) ?? "missing" },
          qa: {
            state: state?.state ?? "pending",
            note: state?.note ?? "",
            updatedAt: state?.updated_at ?? row.updated_at,
          },
        };
      }),
    });
  }, Effect.mapError(passStorage));

  const setQa = Effect.fn("EvidenceService.setQa")(function* (input: EvidenceSetQaInput) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const [row] = yield* sql<QaRow>`UPDATE evidence_qa SET state = ${input.state},
          note = coalesce(${input.note ?? null}, note), updated_at = ${now}
        WHERE landing_id = ${input.landingId} AND change_id = ${input.changeId}
        RETURNING change_id, state, note, updated_at`;
    if (row === undefined)
      return yield* new EvidenceError({
        code: "not_found",
        message: `No change ${input.changeId} in evidence landing ${input.landingId}.`,
      });
    const result = yield* decodeQa({ state: row.state, note: row.note, updatedAt: row.updated_at });
    yield* publish;
    return result;
  }, Effect.mapError(passStorage));

  const counts = Effect.fn("EvidenceService.counts")(function* () {
    const rows = yield* sql<{
      readonly state: EvidenceQaState;
      readonly count: number;
    }>`SELECT state, count(*) AS count FROM evidence_qa WHERE state IN ('pending', 'failed') GROUP BY state`;
    const of = (state: EvidenceQaState) => rows.find((row) => row.state === state)?.count ?? 0;
    return { pending: of("pending"), failed: of("failed") };
  }, Effect.mapError(storage));

  const runGit = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
    git
      .execute({
        operation: "EvidenceService.coverage",
        cwd,
        args,
        ...(stdin === undefined ? {} : { stdin }),
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 && !result.stdoutTruncated ? result.stdout : null,
        ),
        Effect.orElseSucceed(() => null),
      );

  // Rows are one project's landings, newest first; the newest names the branch and the lead's thread.
  const projectCoverage = Effect.fn("EvidenceService.projectCoverage")(function* (
    projectId: string,
    rows: ReadonlyArray<CoverageRow>,
    generation: number,
  ) {
    const newest = rows[0]!;
    const cwd = newest.workspace_root;
    const now = yield* Clock.currentTimeMillis;
    const cached = coverageCache.get(projectId);
    if (cached && now - cached.checkedAt < COVERAGE_TTL_MS) return cached.result;
    const head = newest.branch.startsWith("-")
      ? undefined
      : (yield* runGit(cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${newest.branch}^{commit}`,
        ]))?.trim();
    const same = cached !== undefined && cached.head === head;
    let result = same ? cached.result : null;
    // A failed git run caches no head, so the next check after the TTL runs it again.
    let cachedHead = head ?? "";
    if (head !== undefined && !same) {
      const since = `--since=${rows.at(-1)!.landed_at}`;
      const log = yield* runGit(cwd, [
        "log",
        "--first-parent",
        "--merges",
        since,
        "--format=%H%x1f%P%x1f%s",
        head,
      ]);
      // The oldest merge's first parent bounds the commits these merges can bring in.
      const lastParent = log?.trim().split("\n").at(-1)?.split("\x1f")[1]?.split(" ")[0];
      // Git resolves abbreviations; ambiguous or unknown ones print "missing" and cover nothing.
      const recorded = lastParent
        ? yield* runGit(
            cwd,
            ["cat-file", "--batch-check"],
            rows
              .flatMap((row) => [row.sha, ...(JSON.parse(row.commits) as string[])])
              .filter((sha) => /^[0-9a-f]{4,64}$/i.test(sha))
              .map((sha) => `${sha}^{commit}\n`)
              .join(""),
          )
        : "";
      const revs = lastParent
        ? yield* runGit(cwd, ["rev-list", "--parents", head, `^${lastParent}`])
        : "";
      const failed = log === null || recorded === null || revs === null;
      if (failed) cachedHead = "";
      const resolved = new Set(
        (recorded ?? "").split("\n").flatMap((line) => {
          const [sha = "", type] = line.split(" ");
          return type === "commit" ? [sha] : [];
        }),
      );
      const uncovered = failed || !log ? [] : uncoveredMerges(head, log, revs, resolved);
      result =
        uncovered.length === 0
          ? null
          : {
              projectId: ProjectId.make(projectId),
              branch: newest.branch,
              head,
              leadThreadId: ThreadId.make(newest.thread_id),
              uncoveredCount: uncovered.length,
              uncovered: uncovered.slice(0, 20),
            };
    }
    if (generation === coverageGeneration)
      coverageCache.set(projectId, { head: cachedHead, checkedAt: now, result });
    return result;
  });

  const coverage = Effect.fn("EvidenceService.coverage")(function* (input: EvidenceCoverageInput) {
    const generation = coverageGeneration;
    const rows =
      yield* sql<CoverageRow>`SELECT l.project_id, p.workspace_root, l.thread_id, l.landed_at,
          json_extract(l.record_json, '$.target.branch') AS branch, json_extract(l.record_json, '$.target.sha') AS sha,
          (SELECT json_group_array(c.value) FROM json_each(l.record_json, '$.changes') ch, json_each(ch.value, '$.commits') c) AS commits
        FROM evidence_landings l JOIN projection_projects p ON p.project_id = l.project_id AND p.deleted_at IS NULL
        WHERE ${input.projectId === undefined ? sql`1 = 1` : sql`l.project_id = ${input.projectId}`}
        ORDER BY l.landed_at DESC, l.landing_id DESC`;
    const byProject = Map.groupBy(rows, (row) => row.project_id);
    const results = yield* Effect.forEach(byProject, ([projectId, projectRows]) =>
      coverageLock(projectId).withPermits(1)(projectCoverage(projectId, projectRows, generation)),
    );
    return results.filter((result) => result !== null);
  }, Effect.mapError(storage));

  return EvidenceService.of({
    record,
    list,
    get,
    setQa,
    counts,
    coverage,
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.succeed(revision).pipe(
            Stream.concat(Stream.fromSubscription(subscription)),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(EvidenceService, make);
