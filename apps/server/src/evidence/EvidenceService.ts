import {
  EVIDENCE_LIST_PAGE_SIZE,
  EVIDENCE_RECORD_MAX_BYTES,
  EvidenceChangeQa,
  EvidenceError,
  EvidenceLanding,
  EvidenceLandingSummary,
  EvidenceRecord,
  type EvidenceCounts,
  type EvidenceGetInput,
  type EvidenceListInput,
  type EvidenceListResult,
  type EvidenceQaState,
  type EvidenceRecordInput,
  type EvidenceRecordResult,
  type EvidenceSetQaInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as NotificationService from "../notifications/NotificationService.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

/** Captures must live here, so a record can never point a client at an arbitrary host file. */
const EVIDENCE_ROOT_NAME = "evidence";

export interface RecordInput extends Omit<EvidenceRecordInput, "threadId" | "projectId"> {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  /** The agent's thread, named as the Inbox notification's source. */
  readonly recordedBy: ThreadId;
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
  }),
);
const decodeQa = Schema.decodeUnknownEffect(EvidenceChangeQa);

const invalid = (message: string) => new EvidenceError({ code: "invalid", message });
const storage = (cause: unknown) =>
  new EvidenceError({ code: "storage", message: "Evidence storage failed.", cause });
const isEvidenceError = Schema.is(EvidenceError);
const passStorage = (error: unknown) => (isEvidenceError(error) ? error : storage(error));

const firstLine = (text: string, max: number) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const notifications = yield* NotificationService.NotificationService;

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

  const readQa = (landingId: string) =>
    sql<QaRow>`SELECT change_id, state, note, updated_at FROM evidence_qa WHERE landing_id = ${landingId}`;

  const notify = Effect.fnUntraced(function* (input: RecordInput, pending: number) {
    const count = input.changes.length;
    const asks = input.changes.map(
      (change) => `- ${change.ticket?.key ?? change.id}: ${firstLine(change.ask, 160)}`,
    );
    const body = [firstLine(input.title, 200), ...asks].join("\n");
    yield* notifications.raise({
      severity: "info",
      title: `Landed ${count} change${count === 1 ? "" : "s"} – QA waiting on ${pending}`,
      body: body.length > 4000 ? `${body.slice(0, 3999)}…` : body,
      source: { kind: "agent", threadId: input.recordedBy },
      threadId: input.threadId,
      projectId: input.projectId,
      dedupeKey: `evidence:${input.id}`,
    });
  });

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
    const changes = [];
    for (const change of input.changes) {
      const captures = [];
      for (const capture of change.captures)
        captures.push({ ...capture, path: yield* checkCapture(capture.path, root, warnings) });
      changes.push({ ...change, captures });
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
    const { qa, added } = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO evidence_landings (landing_id, thread_id, project_id, landed_at, record_json, updated_at)
              VALUES (${input.id}, ${input.threadId}, ${input.projectId}, ${landedAt ?? now}, ${recordJson}, ${now})
              ON CONFLICT (landing_id) DO UPDATE SET thread_id = excluded.thread_id, project_id = excluded.project_id,
              landed_at = coalesce(${landedAt ?? null}, landed_at), record_json = excluded.record_json, updated_at = excluded.updated_at`;
          yield* sql`DELETE FROM evidence_qa WHERE landing_id = ${input.id} AND change_id NOT IN ${sql.in(ids)}`;
          let added = 0;
          for (const id of ids) {
            const inserted =
              yield* sql`INSERT INTO evidence_qa (landing_id, change_id, state, note, updated_at)
                VALUES (${input.id}, ${id}, 'pending', '', ${now}) ON CONFLICT DO NOTHING RETURNING change_id`;
            added += inserted.length;
          }
          return { qa: yield* readQa(input.id), added };
        }),
      )
      .pipe(Effect.mapError(storage));
    const states = new Map(qa.map((row) => [row.change_id, row.state]));
    const pending = qa.filter((row) => row.state === "pending").length;
    // Only new changes ask for QA again, so a re-record that adds a check stays quiet.
    if (added > 0)
      yield* notify(input, pending).pipe(
        Effect.catch((error) =>
          Effect.sync(() => warnings.push(`inbox notification skipped: ${error.message}`)),
        ),
      );
    return {
      landingId: input.id,
      changes: ids.map((id) => ({ id, qa: states.get(id) ?? "pending" })),
      warnings,
    };
  }, Effect.mapError(passStorage));

  const list = Effect.fn("EvidenceService.list")(function* (input: EvidenceListInput) {
    const before = input.before;
    const rows = yield* sql<{
      readonly id: string;
      readonly title: string;
      readonly thread_id: string;
      readonly project_id: string | null;
      readonly landed_at: string;
      readonly target: string;
      readonly verifications: string;
      readonly change_count: number;
      readonly pending: number;
      readonly confirmed: number;
      readonly failed: number;
      readonly waived: number;
    }>`SELECT l.landing_id AS id, json_extract(l.record_json, '$.title') AS title, l.thread_id, l.project_id, l.landed_at,
          json_extract(l.record_json, '$.target') AS target,
          (SELECT json_group_array(json_object('label', json_extract(v.value, '$.label'), 'result', json_extract(v.value, '$.result')))
            FROM json_each(l.record_json, '$.verifications') v) AS verifications,
          json_array_length(l.record_json, '$.changes') AS change_count,
          count(q.change_id) FILTER (WHERE q.state = 'pending') AS pending,
          count(q.change_id) FILTER (WHERE q.state = 'confirmed') AS confirmed,
          count(q.change_id) FILTER (WHERE q.state = 'failed') AS failed,
          count(q.change_id) FILTER (WHERE q.state = 'waived') AS waived
        FROM evidence_landings l LEFT JOIN evidence_qa q ON q.landing_id = l.landing_id
        WHERE ${input.threadId === undefined ? sql`1 = 1` : sql`l.thread_id = ${input.threadId}`}
          AND ${before === undefined ? sql`1 = 1` : sql`(l.landed_at < ${before.landedAt} OR (l.landed_at = ${before.landedAt} AND l.landing_id < ${before.id}))`}
        GROUP BY l.landing_id
        HAVING ${input.needsQa === true ? sql`pending + failed > 0` : sql`1 = 1`}
        ORDER BY l.landed_at DESC, l.landing_id DESC
        LIMIT ${EVIDENCE_LIST_PAGE_SIZE + 1}`;
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
        qa: {
          pending: row.pending,
          confirmed: row.confirmed,
          failed: row.failed,
          waived: row.waived,
        },
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
  }, Effect.mapError(storage));

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
    return yield* decodeLanding({
      ...stored,
      threadId: row.thread_id,
      projectId: row.project_id,
      landedAt: row.landed_at,
      updatedAt: row.updated_at,
      changes: stored.changes.map((change) => {
        const state = qa.get(change.id);
        return {
          ...change,
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
    return yield* decodeQa({ state: row.state, note: row.note, updatedAt: row.updated_at });
  }, Effect.mapError(passStorage));

  const counts = Effect.fn("EvidenceService.counts")(function* () {
    const rows = yield* sql<{
      readonly state: EvidenceQaState;
      readonly count: number;
    }>`SELECT state, count(*) AS count FROM evidence_qa WHERE state IN ('pending', 'failed') GROUP BY state`;
    const of = (state: EvidenceQaState) => rows.find((row) => row.state === state)?.count ?? 0;
    return { pending: of("pending"), failed: of("failed") };
  }, Effect.mapError(storage));

  return EvidenceService.of({ record, list, get, setQa, counts });
});

export const layer = Layer.effect(EvidenceService, make);
