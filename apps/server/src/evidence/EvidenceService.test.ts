import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EvidenceRecord,
  EvidenceRecordInput,
  EvidenceBulkSetQaInput,
  EvidenceSetQaInput,
  MessageId,
  ProjectId,
  ThreadId,
  EvidenceChange,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AssetSigner from "../assets/AssetSigner.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as NotificationService from "../notifications/NotificationService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Service from "./EvidenceService.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-evidence-test-",
});
/** Counts the coverage check's git runs, can mark their output truncated, and can hold `log` in one repo. */
const gitProbe: {
  calls: number;
  truncate: boolean;
  holdLog: { cwd: string; until: Effect.Effect<void> } | null;
} = { calls: 0, truncate: false, holdLog: null };
const layerGitProbe = Layer.effect(
  GitVcsDriver.GitVcsDriver,
  Effect.gen(function* () {
    const real = yield* GitVcsDriver.GitVcsDriver;
    return {
      ...real,
      execute: (input: GitVcsDriver.ExecuteGitInput) =>
        input.operation !== "EvidenceService.coverage"
          ? real.execute(input)
          : Effect.sync(() => gitProbe.calls++).pipe(
              Effect.andThen(
                input.args[0] === "log" && gitProbe.holdLog?.cwd === input.cwd
                  ? gitProbe.holdLog.until
                  : Effect.void,
              ),
              Effect.andThen(real.execute(input)),
              Effect.map((result) => ({ ...result, stdoutTruncated: gitProbe.truncate })),
            ),
    };
  }),
).pipe(Layer.provide(GitVcsDriver.layer.pipe(Layer.provideMerge(VcsProcess.layer))));

const testLayer = Service.layer.pipe(
  Layer.provideMerge(NotificationService.layer),
  Layer.provideMerge(layerGitProbe),
  Layer.provideMerge(
    Layer.mergeAll(
      Sqlite.layerMemory,
      NodeHttpPlatform.layer,
      layerConfig,
      WorkspacePaths.layer,
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
      NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
      AssetSigner.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(layerConfig))),
      ),
    ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);

const lead = ThreadId.make("lead");
const project = ProjectId.make("project-1");
const change = (id: string, overrides: Partial<EvidenceChange> = {}): EvidenceChange => ({
  id,
  ask: `Ask for ${id}\nmore detail`,
  commits: ["a1b2c3d"],
  summary: `Changed ${id}`,
  review: { verdict: "approved", by: "opus" },
  captures: [],
  gaps: ["Not tried on a slow network."],
  ...overrides,
});
const recordInput = (
  id: string,
  changes: ReadonlyArray<EvidenceChange>,
  extra: Partial<Service.RecordInput> = {},
): Service.RecordInput => ({
  id,
  title: `Landing ${id}`,
  target: { branch: "main", sha: "abc1234" },
  verifications: [{ label: "gate", result: "pass", runId: "run-1", detail: "long detail" }],
  changes,
  threadId: lead,
  projectId: project,
  ...extra,
});

/** Changes waiting for the user's QA, and problems the agent owes a fix for, in every thread. */
const qaCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly state: string; readonly count: number }>`SELECT state,
      count(*) AS count FROM evidence_qa
      WHERE (state = 'pending' AND discussed_message_id IS NULL) OR state = 'problem'
      GROUP BY state`;
  const of = (state: string) => rows.find((row) => row.state === state)?.count ?? 0;
  return { pending: of("pending"), problem: of("problem") };
});

/** A scoped home with an evidence root, so nothing touches the real one. */
const withHome = <A, E, R>(body: (home: string, root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-ev-home-" }));
    const root = path.join(home, "evidence", "t3code", "work");
    yield* fs.makeDirectory(root, { recursive: true });
    return yield* body(home, root).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
  });

const errorOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.message));

it.effect(
  "re-recording keeps the user's QA, starts new changes pending and drops removed ones",
  () =>
    withHome(() =>
      Effect.gen(function* () {
        const evidence = yield* Service.EvidenceService;
        const first = yield* evidence.record(recordInput("batch-1", [change("a"), change("b")]));
        const unverified = ["gaps"] as const;
        assert.deepStrictEqual(first.changes, [
          { id: "a", qa: "pending", raised: [...unverified], ref: 1 },
          { id: "b", qa: "pending", raised: [...unverified], ref: 2 },
        ]);
        yield* evidence.setQa({
          landingId: "batch-1",
          changeId: "a",
          state: "waived",
          note: "Not worth checking",
        });
        yield* evidence.setQa({ landingId: "batch-1", changeId: "b", state: "confirmed" });
        assert.deepStrictEqual(yield* qaCounts, { pending: 0, problem: 0 });

        const again = yield* evidence.record(recordInput("batch-1", [change("a"), change("c")]));
        assert.deepStrictEqual(again.changes, [
          { id: "a", qa: "waived", raised: [...unverified], ref: 1 },
          { id: "c", qa: "pending", raised: [...unverified], ref: 3 },
        ]);
        const landing = yield* evidence.get({ landingId: "batch-1" });
        assert.deepStrictEqual(
          landing.changes.map((item) => [item.id, item.qa.state, item.qa.note]),
          [
            ["a", "waived", "Not worth checking"],
            ["c", "pending", ""],
          ],
        );
        assert.deepStrictEqual(yield* qaCounts, { pending: 1, problem: 0 });

        // Another thread reusing the id is refused, so it can neither take the landing nor reset QA.
        const other = ThreadId.make("other");
        for (const changes of [[change("x")], [change("a"), change("c")]]) {
          const error = yield* Effect.flip(
            evidence.record(recordInput("batch-1", changes, { threadId: other })),
          );
          assert.strictEqual(error.code, "invalid");
          assert.strictEqual(
            error.message,
            "Landing id batch-1 is already used by thread lead; pick another id.",
          );
        }
        const kept = yield* evidence.get({ landingId: "batch-1" });
        assert.strictEqual(kept.threadId, lead);
        assert.deepStrictEqual(
          kept.changes.map((item) => item.qa.state),
          ["waived", "pending"],
        );
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "walks the user's QA through every state, keeps a note on the same state, and refuses unknown ids",
  () =>
    withHome(() =>
      Effect.gen(function* () {
        const evidence = yield* Service.EvidenceService;
        yield* evidence.record(recordInput("batch-1", [change("a")]));
        const states = ["confirmed", "waived", "pending", "confirmed"] as const;
        for (const state of states) {
          const qa = yield* evidence.setQa({ landingId: "batch-1", changeId: "a", state });
          assert.strictEqual(qa.state, state);
          assert.strictEqual(qa.by, "user");
        }
        yield* evidence.setQa({ landingId: "batch-1", changeId: "a", state: "waived" });
        yield* evidence.setQa({ landingId: "batch-1", changeId: "a", state: "waived", note: "x" });
        const kept = yield* evidence.setQa({
          landingId: "batch-1",
          changeId: "a",
          state: "waived",
        });
        assert.strictEqual(kept.note, "x");
        const reopened = yield* evidence.setQa({
          landingId: "batch-1",
          changeId: "a",
          state: "pending",
        });
        assert.strictEqual(reopened.note, "");
        for (const input of [
          { landingId: "batch-1", changeId: "missing" },
          { landingId: "missing", changeId: "a" },
        ]) {
          const error = yield* Effect.flip(evidence.setQa({ ...input, state: "confirmed" }));
          assert.strictEqual(error.code, "not_found");
        }
        assert.strictEqual(
          (yield* Effect.flip(evidence.get({ landingId: "missing" }))).code,
          "not_found",
        );
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("lists compact summaries newest first, pages, and filters by thread and QA", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      for (let index = 0; index < 23; index++) {
        const hour = String(index).padStart(2, "0");
        yield* evidence.record(
          recordInput(
            `batch-${hour}`,
            [change("a", { summary: "x".repeat(1900), gaps: ["not proven"] }), change("b")],
            {
              landedAt: `2026-11-14T${hour}:00:00Z`,
              threadId: index % 2 === 0 ? lead : ThreadId.make("other"),
            },
          ),
        );
      }
      // Same landedAt as batch-22 so the cursor needs its id tiebreak.
      yield* evidence.record(
        recordInput("batch-22b", [change("a")], { landedAt: "2026-11-14T22:00:00.000Z" }),
      );
      for (let index = 0; index < 22; index++) {
        const hour = String(index).padStart(2, "0");
        for (const id of ["a", "b"])
          yield* evidence.setQa({ landingId: `batch-${hour}`, changeId: id, state: "confirmed" });
      }

      const page = yield* evidence.list({});
      assert.strictEqual(page.items.length, 20);
      assert.deepStrictEqual(
        page.items.slice(0, 3).map((item) => item.id),
        ["batch-22b", "batch-22", "batch-21"],
      );
      assert.deepStrictEqual(page.items[1], {
        id: "batch-22",
        title: "Landing batch-22",
        threadId: lead,
        projectId: project,
        landedAt: "2026-11-14T22:00:00.000Z",
        target: { branch: "main", sha: "abc1234" },
        verifications: [{ label: "gate", result: "pass" }],
        changeCount: 2,
        qa: { pending: 2, quiet: 0, confirmed: 0, problem: 0, waived: 0 },
      });
      // Summaries never carry changes, summaries or captures.
      assert.isBelow(JSON.stringify(page.items[1]).length, 400);
      assert.isNotNull(page.next);
      const rest = yield* evidence.list({ before: page.next! });
      assert.deepStrictEqual(
        rest.items.map((item) => item.id),
        ["batch-03", "batch-02", "batch-01", "batch-00"],
      );
      assert.isNull(rest.next);

      assert.deepStrictEqual(
        (yield* evidence.list({ needsQa: true })).items.map((item) => item.id),
        ["batch-22b", "batch-22"],
      );
      // A cursor written without milliseconds still pages after batch-22, not into it.
      const handWritten = yield* evidence.list({
        before: { landedAt: "2026-11-14T22:00:00Z", id: "batch-22" },
      });
      assert.strictEqual(handWritten.items[0]!.id, "batch-21");
      assert.strictEqual(
        (yield* Effect.flip(evidence.list({ before: { landedAt: "soon", id: "x" } }))).message,
        "Invalid cursor landedAt: soon",
      );

      const other = yield* evidence.list({ threadId: ThreadId.make("other") });
      assert.strictEqual(other.items.length, 11);
      assert.isTrue(other.items.every((item) => item.threadId === "other"));
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps captures under the evidence root and refuses everything else", () =>
  withHome((home, root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const evidence = yield* Service.EvidenceService;
      const shot = path.join(root, "after.png");
      yield* fs.writeFileString(shot, "png");
      yield* fs.writeFileString(path.join(root, "REVIEW.md"), "review");
      yield* fs.writeFileString(path.join(home, "secret.png"), "secret");
      const captures = (paths: ReadonlyArray<string>) =>
        recordInput("captures", [
          change("a", { captures: paths.map((p) => ({ path: p, caption: "shot" })) }),
        ]);

      const result = yield* evidence.record(
        captures(["~/evidence/t3code/work/after.png", `${root}/gone.png`, `${root}/REVIEW.md`]),
      );
      assert.deepStrictEqual(result.warnings, [
        `capture missing: ${root}/gone.png`,
        `capture not previewable: ${root}/REVIEW.md`,
      ]);
      const stored = (yield* evidence.get({ landingId: "captures" })).changes[0]!.captures;
      assert.deepStrictEqual(
        stored.map((capture) => capture.path),
        [shot, `${root}/gone.png`, `${root}/REVIEW.md`],
      );

      for (const [raw, message] of [
        ["evidence/after.png", "Capture path must be absolute: evidence/after.png"],
        [path.join(home, "secret.png"), `Capture must be under ${home}/evidence`],
        [`${root}/../../../secret.png`, `Capture must be under ${home}/evidence`],
        ["/etc/hostname.png", `Capture must be under ${home}/evidence`],
      ] as const) {
        const error = yield* Effect.flip(evidence.record(captures([raw])));
        assert.strictEqual(error.code, "invalid");
        assert.include(error.message, message);
      }
      if (symlinksSupported) {
        yield* fs.symlink(path.join(home, "secret.png"), path.join(root, "link.png"));
        assert.include(
          yield* errorOf(evidence.record(captures([`${root}/link.png`]))),
          "Capture must be under",
        );
      }
      // A refused record leaves the stored one untouched.
      assert.strictEqual(
        (yield* evidence.get({ landingId: "captures" })).changes[0]!.captures.length,
        3,
      );

      // The stored path is what clients send to the existing signed media-file asset URL.
      const issued = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId: lead, path: stored[0]!.path },
      });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      assert.deepInclude(
        yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
        { kind: "file", path: shot },
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("refuses duplicate change ids, bad dates and records over 64 KB", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      assert.strictEqual(
        yield* errorOf(evidence.record(recordInput("dup", [change("a"), change("a")]))),
        "Duplicate change id: a",
      );
      assert.strictEqual(
        yield* errorOf(evidence.record(recordInput("date", [change("a")], { landedAt: "soon" }))),
        "Invalid landedAt: soon",
      );
      const big = Array.from({ length: 20 }, (_, index) =>
        change(`c${index}`, { summary: "y".repeat(2000), ask: "z".repeat(2000) }),
      );
      assert.match(
        yield* errorOf(evidence.record(recordInput("big", big))),
        /^Record is \d+ bytes; the limit is 65536/,
      );
      assert.deepStrictEqual((yield* evidence.list({})).items, []);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it("the record contract refuses shapes the agent cannot send", () => {
  const decode = Schema.decodeUnknownExit(EvidenceRecordInput);
  const valid = recordInput("ok", [change("a")]);
  assert.isTrue(decode(valid)._tag === "Success");
  const { changes: _changes, ...exempt } = {
    ...valid,
    exempt: { reason: "Docs-only fix with nothing to check." },
  };
  assert.isTrue(decode(exempt)._tag === "Success");
  assert.isTrue(decode({ ...exempt, changes: [] })._tag === "Success");
  for (const bad of [
    { ...valid, changes: [] },
    { ...exempt, changes: [change("a")] },
    { ...exempt, exempt: { reason: "first line\nsecond line" } },
    { ...exempt, exempt: { reason: " " } },
    { ...valid, id: "has space" },
    { ...valid, changes: [change("a", { commits: ["not-a-sha"] })] },
    { ...valid, changes: Array.from({ length: 21 }, (_, index) => change(`c${index}`)) },
  ])
    assert.isTrue(decode(bad)._tag === "Failure");
});

it.effect("publishes evidence changes without adding anything to the inbox", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const notifications = yield* NotificationService.NotificationService;
      const events = yield* Queue.unbounded<number>();
      yield* Stream.runForEach(evidence.subscribe(), (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      assert.strictEqual(yield* Queue.take(events), 0);
      for (let index = 0; index <= NotificationService.RATE_LIMIT_PER_HOUR; index++) {
        const result = yield* evidence.record(recordInput(`batch-${index}`, [change("a")]));
        assert.deepStrictEqual(result.warnings, []);
        assert.strictEqual(yield* Queue.take(events), index + 1);
      }
      yield* evidence.setQa({ landingId: "batch-0", changeId: "a", state: "confirmed" });
      assert.strictEqual(yield* Queue.take(events), NotificationService.RATE_LIMIT_PER_HOUR + 2);
      const snapshot = yield* notifications.subscribe().pipe(Stream.runHead);
      assert.deepStrictEqual(Option.getOrThrow(snapshot).items, []);
    }),
  ).pipe(Effect.provide(testLayer)),
);

/** A scratch repository registered as `project`, with fixed dates so its commit ids never change. */
const scratchRepo = (projectId: ProjectId = project) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-ev-repo-" }));
    const git = (args: ReadonlyArray<string>, date = "2026-01-01T00:00:00Z", stdin?: string) =>
      driver
        .execute({
          operation: "test",
          cwd: repo,
          args,
          env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
          ...(stdin === undefined ? {} : { stdin }),
        })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const commit = (message: string) =>
      git(["commit", "--allow-empty", "-m", message]).pipe(
        Effect.andThen(git(["rev-parse", "HEAD"])),
      );
    const merge = (branch: string, from: string, date?: string) =>
      Effect.gen(function* () {
        if (from !== branch) yield* git(["checkout", "-q", "-b", branch, from]);
        const work = from === branch ? "" : yield* commit(`work on ${branch}`);
        yield* git(["checkout", "-q", "main"]);
        yield* git(["merge", "--no-ff", "-m", `Merge ${branch}`, branch], date);
        return { work, merge: yield* git(["rev-parse", "HEAD"]) };
      });
    yield* git(["init", "-q", "-b", "main"]);
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@test.com"],
      ["commit.gpgsign", "false"],
      ["core.hooksPath", "/dev/null"],
    ] as const)
      yield* git(["config", key, value]);
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Repo', ${repo}, '[]', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`;
    gitProbe.calls = 0;
    gitProbe.truncate = false;
    gitProbe.holdLog = null;
    return { repo, git, commit, merge, base: yield* commit("base") };
  });

it.effect("flags merges on the target branch that no landing covers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const evidence = yield* Service.EvidenceService;
    const { repo, git, commit, merge, base } = yield* scratchRepo();
    // Committed before the first landing, so it predates Evidence and never flags.
    yield* git(["checkout", "-q", "-b", "old"]);
    yield* commit("work on old");
    yield* merge("old", "old", "1999-06-01T00:00:00Z");
    const first = yield* merge("first", "main");
    // Branched from `first`'s work: its merge brings in only its own commit.
    const second = yield* merge("second", first.work);
    const third = yield* merge("third", "main");
    yield* commit("direct fixup on main");
    const cutoff = (commits: ReadonlyArray<string>) =>
      evidence.record(
        recordInput("cutoff", [change("a", { commits })], {
          target: { branch: "main", sha: base },
          landedAt: "2000-01-01T00:00:00.000Z",
        }),
      );
    yield* cutoff([first.work.slice(0, 7)]);

    // Two cold calls at once share one run: rev-parse, log, cat-file and rev-list.
    const [[flagged], [same]] = yield* Effect.all([evidence.coverage({}), evidence.coverage({})], {
      concurrency: "unbounded",
    });
    assert.strictEqual(gitProbe.calls, 4);
    assert.deepStrictEqual(same, flagged);
    assert.deepStrictEqual(flagged, {
      projectId: project,
      branch: "main",
      head: yield* git(["rev-parse", "main"]),
      leadThreadId: lead,
      uncoveredCount: 2,
      uncovered: [
        { sha: third.merge, subject: "Merge third" },
        { sha: second.merge, subject: "Merge second" },
      ],
    });

    // Re-recording with the same timestamp still recomputes; `second`'s commit now covers it.
    yield* cutoff([first.work.slice(0, 7), second.work]);
    const [rerecorded] = yield* evidence.coverage({});
    assert.deepStrictEqual(
      rerecorded?.uncovered.map(({ sha }) => sha),
      [third.merge],
    );

    // A new landing's target sha covers `third`.
    yield* evidence.record(
      recordInput("later", [change("b", { commits: [] })], {
        target: { branch: "main", sha: third.merge },
        landedAt: "2001-01-01T00:00:00.000Z",
      }),
    );
    assert.deepStrictEqual(yield* evidence.coverage({ projectId: project }), []);

    // Within the TTL nothing runs git, so a vanished repository still answers from cache.
    yield* cutoff([first.work.slice(0, 7)]);
    assert.strictEqual((yield* evidence.coverage({}))[0]?.uncoveredCount, 1);
    gitProbe.calls = 0;
    yield* fs.remove(repo, { recursive: true });
    assert.strictEqual((yield* evidence.coverage({}))[0]?.uncoveredCount, 1);
    assert.strictEqual(gitProbe.calls, 0);
    yield* TestClock.adjust("31 seconds");
    assert.deepStrictEqual(yield* evidence.coverage({}), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("finds the uncovered commits a branch gained while a window was open", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const evidence = yield* Service.EvidenceService;
    const { repo, git, commit, base } = yield* scratchRepo();
    // Committed long before they land: a fast-forward keeps their committer times.
    yield* git(["checkout", "-q", "-b", "feature"]);
    const first = yield* commit("first feature commit");
    const second = yield* commit("second feature commit");
    yield* git(["checkout", "-q", "main"]);
    yield* git(["merge", "-q", "--ff-only", "feature"], "2026-02-01T00:00:00Z");
    const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
    const landedWindow = { fromMs: at("2026-02-01T00:00:00Z"), toMs: at("2026-02-01T00:00:05Z") };

    const target = yield* evidence.landingTarget(project);
    assert.deepStrictEqual(target, { projectId: project, cwd: repo, branch: "main", remote: null });
    const landed = (windows = [landedWindow]) =>
      evidence
        .uncoveredLanded({ target: target!, windows })
        .pipe(Effect.map((commits) => commits.map(({ sha }) => sha)));
    assert.deepStrictEqual(yield* landed(), [second, first]);
    // Nothing moved in mid-January, and the branch was created, not moved, on January 1.
    assert.deepStrictEqual(
      yield* landed([
        { fromMs: at("2026-01-15T00:00:00Z"), toMs: at("2026-01-16T00:00:00Z") },
        { fromMs: at("2025-12-31T00:00:00Z"), toMs: at("2026-01-02T00:00:00Z") },
      ]),
      [],
    );

    yield* evidence.record(
      recordInput("partial", [change("a", { commits: [first.slice(0, 7)] })], {
        target: { branch: "main", sha: base },
      }),
    );
    assert.deepStrictEqual(yield* landed(), [second]);
    // An exemption names the tip it left, which covers the whole batch it landed.
    yield* evidence.record({
      ...recordInput("docs-only", [], { target: { branch: "main", sha: second } }),
      changes: [],
      exempt: { reason: "Docs-only change." },
    });
    assert.deepStrictEqual(yield* landed(), []);
    const listed = (yield* evidence.list({})).items.find((item) => item.id === "docs-only");
    assert.deepStrictEqual(
      { changeCount: listed?.changeCount, exempt: listed?.exempt },
      { changeCount: 0, exempt: { reason: "Docs-only change." } },
    );

    // A push to the remote's branch moves the remote-tracking ref while local main stays put.
    const remote = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-ev-remote-" }),
    );
    yield* git(["init", "-q", "--bare", remote]);
    yield* git(["remote", "add", "origin", remote]);
    yield* git(["push", "-q", "origin", "main"], "2026-03-01T00:00:00Z");
    yield* git(["checkout", "-q", "-b", "pushed"]);
    const pushed = yield* commit("pushed straight to the remote");
    yield* git(["push", "-q", "origin", "pushed:main"], "2026-03-02T00:00:00Z");
    const remoteTarget = yield* evidence.landingTarget(project);
    assert.deepStrictEqual(remoteTarget?.remote, "origin");
    assert.deepStrictEqual(
      (yield* evidence.uncoveredLanded({
        target: remoteTarget!,
        windows: [{ fromMs: at("2026-03-02T00:00:00Z"), toMs: at("2026-03-02T00:00:01Z") }],
      })).map(({ sha }) => sha),
      [pushed],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("treats truncated git output as a failure and retries it after the TTL", () =>
  Effect.gen(function* () {
    const evidence = yield* Service.EvidenceService;
    const { merge, base } = yield* scratchRepo();
    yield* merge("first", "main");
    yield* merge("second", "main");
    yield* evidence.record(
      recordInput("cutoff", [change("a", { commits: [] })], {
        target: { branch: "main", sha: base },
        landedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    gitProbe.truncate = true;
    assert.deepStrictEqual(yield* evidence.coverage({}), []);
    gitProbe.truncate = false;
    yield* TestClock.adjust("31 seconds");
    assert.strictEqual((yield* evidence.coverage({}))[0]?.uncoveredCount, 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("an abbreviated sha that git finds ambiguous covers nothing", () =>
  Effect.gen(function* () {
    const evidence = yield* Service.EvidenceService;
    const { git, merge, base } = yield* scratchRepo();
    // Two branches of 400 commits each share at least one 4-character prefix across them.
    const branch = (name: string) =>
      git(
        ["fast-import", "--quiet"],
        undefined,
        Array.from(
          { length: 400 },
          (_, index) =>
            `commit refs/heads/${name}\ncommitter Test <test@test.com> ${1767225600 + index} +0000\ndata ${`${name} ${index}`.length}\n${name} ${index}\n${index === 0 ? `from ${base}\n` : ""}`,
        ).join("\n"),
      ).pipe(Effect.andThen(git(["rev-list", `${base}..${name}`])));
    const left = (yield* branch("left")).split("\n");
    const right = new Set((yield* branch("right")).split("\n").map((sha) => sha.slice(0, 4)));
    const shared = left.find((sha) => right.has(sha.slice(0, 4)))!.slice(0, 4);
    const leftMerge = yield* merge("left", "left");
    const rightMerge = yield* merge("right", "right");
    yield* evidence.record(
      recordInput("cutoff", [change("a", { commits: [shared] })], {
        target: { branch: "main", sha: base },
        landedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    assert.deepStrictEqual(
      (yield* evidence.coverage({}))[0]?.uncovered.map(({ sha }) => sha),
      [rightMerge.merge, leftMerge.merge],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a check in flight when evidence is recorded never caches its older answer", () =>
  Effect.gen(function* () {
    const evidence = yield* Service.EvidenceService;
    const { repo, merge, base } = yield* scratchRepo();
    const first = yield* merge("first", "main");
    const second = yield* merge("second", "main");
    const cutoff = (commits: ReadonlyArray<string>) =>
      evidence.record(
        recordInput("cutoff", [change("a", { commits })], {
          target: { branch: "main", sha: base },
          landedAt: "2000-01-01T00:00:00.000Z",
        }),
      );
    yield* cutoff([first.work, second.work]);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    gitProbe.holdLog = {
      cwd: repo,
      until: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    };
    const stale = yield* Effect.forkChild(evidence.coverage({}));
    yield* Deferred.await(started);
    yield* cutoff([]);
    gitProbe.holdLog = null;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stale);
    assert.strictEqual((yield* evidence.coverage({}))[0]?.uncoveredCount, 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a slow repository doesn't hold up another project's cached answer", () =>
  Effect.gen(function* () {
    const evidence = yield* Service.EvidenceService;
    const other = ProjectId.make("project-2");
    const slow = yield* scratchRepo();
    const fast = yield* scratchRepo(other);
    yield* slow.merge("slow", "main");
    yield* fast.merge("fast", "main");
    for (const [id, projectId, base] of [
      ["slow-cutoff", project, slow.base],
      ["fast-cutoff", other, fast.base],
    ] as const)
      yield* evidence.record(
        recordInput(id, [change("a", { commits: [] })], {
          target: { branch: "main", sha: base },
          landedAt: "2000-01-01T00:00:00.000Z",
          projectId,
        }),
      );
    assert.strictEqual((yield* evidence.coverage({ projectId: other }))[0]?.uncoveredCount, 1);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    gitProbe.holdLog = {
      cwd: slow.repo,
      until: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    };
    const held = yield* Effect.forkChild(evidence.coverage({ projectId: project }));
    yield* Deferred.await(started);
    assert.strictEqual((yield* evidence.coverage({ projectId: other }))[0]?.uncoveredCount, 1);
    yield* Deferred.succeed(release, undefined);
    assert.strictEqual((yield* Fiber.join(held))[0]?.uncoveredCount, 1);
  }).pipe(Effect.provide(testLayer)),
);

const decodeRecord = Schema.decodeUnknownExit(EvidenceRecordInput);
const decodeQa = Schema.decodeUnknownExit(EvidenceSetQaInput);
const decodeStoredRecord = Schema.decodeUnknownExit(EvidenceRecord);
const decodeChange = Schema.decodeUnknownExit(EvidenceChange);

/** Seeds one task the lead delegated; a null child is a delegate running in a linked environment. */
const seedTask = (input: {
  readonly taskId: string;
  readonly parent: string;
  readonly child: string | null;
  readonly role?: string;
  readonly startedAt?: string;
  /** Null leaves the task running. */
  readonly completedAt?: string | null;
  readonly prompt?: string;
  readonly result?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const startedAt = input.startedAt ?? "2026-11-20T10:00:00.000Z";
    const completedAt = input.completedAt === undefined ? startedAt : input.completedAt;
    const task = JSON.stringify({
      prompt: input.prompt ?? "",
      result: input.result ?? null,
      ...(input.role === undefined ? {} : { delegateRole: input.role }),
    });
    yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider,
        child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json)
      VALUES (${input.taskId}, ${input.parent}, 'node', 'codex', ${input.child}, 'app_owned',
        ${completedAt === null ? "running" : "completed"}, ${startedAt}, ${completedAt}, ${startedAt}, ${task})`;
  });

/** Seeds a thread and, for a delegated child, the lead's task record that started it. */
const seedThread = (input: {
  readonly id: string;
  readonly parent?: string;
  readonly role?: string;
  readonly branch?: string;
  readonly startedAt?: string;
  /** Null leaves the task running. */
  readonly completedAt?: string | null;
  readonly prompt?: string;
  readonly result?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      lineage: {
        parentThreadId: input.parent ?? null,
        relationshipToParent: input.parent === undefined ? null : "subagent",
      },
      ...(input.role === undefined ? {} : { delegateRole: input.role }),
      branch: input.branch ?? null,
    });
    const now = "2026-11-20T10:00:00.000Z";
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider,
        runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${input.id}, ${project}, ${input.id}, 'codex', 'full-access', 'default', ${now}, ${now}, ${payload})`;
    if (input.parent === undefined) return;
    yield* seedTask({
      taskId: `task-${input.id}`,
      parent: input.parent,
      child: input.id,
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.result === undefined ? {} : { result: input.result }),
    });
  });

const landedAt = "2026-11-20T11:00:00.000Z";
const reviewsOf = (landingId: string) =>
  Service.EvidenceService.pipe(
    Effect.flatMap((evidence) => evidence.get({ landingId })),
    Effect.map((landing) => landing.changes.map((item) => item.review)),
  );
it.effect("stores every claimed review as unverified and never changes the claimed verdict", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* seedThread({ id: "other-lead" });
      yield* seedThread({ id: "impl", parent: "lead", role: "implementation", branch: "feat-a" });
      // A finished reviewer whose brief names the change and whose last line approves it.
      yield* seedThread({
        id: "reviewer",
        parent: "lead",
        role: "review",
        prompt: "Review branch feat-a at a1b2c3d.",
        result: "No findings.\n\nVerdict: approved",
      });
      yield* seedThread({
        id: "running",
        parent: "lead",
        role: "review",
        completedAt: null,
        prompt: "Review feat-a.",
      });
      yield* seedThread({ id: "elsewhere", parent: "other-lead", role: "review" });
      const claim = (id: string, threadId?: string) =>
        change(id, {
          branch: "feat-a",
          review: {
            verdict: "changes_requested",
            by: "opus",
            ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
          },
        });
      const result = yield* evidence.record(
        recordInput(
          "claims",
          [
            claim("no-reviewer"),
            claim("cited", "reviewer"),
            claim("cited-running", "running"),
            claim("missing", "no-such-thread"),
            claim("not-review", "impl"),
            claim("other-lead", "elsewhere"),
            change("waived", { review: { verdict: "waived", reason: "Docs typo." } }),
          ],
          { landedAt },
        ),
      );
      assert.deepStrictEqual(result.warnings, [
        "change missing: dropped review.threadId no-such-thread because it is not a thread this lead delegated",
        "change not-review: dropped review.threadId impl because it was not delegated with role review",
        "change other-lead: dropped review.threadId elsewhere because it is not a thread this lead delegated",
      ]);
      const unverified = { verdict: "changes_requested", by: "opus", check: "unverified" } as const;
      assert.deepStrictEqual(yield* reviewsOf("claims"), [
        unverified,
        { ...unverified, threadId: ThreadId.make("reviewer"), thread: "reviewer" },
        { ...unverified, threadId: ThreadId.make("running"), thread: "reviewer" },
        unverified,
        unverified,
        unverified,
        { verdict: "waived", reason: "Docs typo." },
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps the claimed verdict when the reviewer of that change approved it", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* seedThread({
        id: "reviewer",
        parent: "lead",
        role: "review",
        prompt: "Review branch feat-a.",
        result: "No findings.\n\nVerdict: approved",
      });
      const claimed = { verdict: "changes_requested", by: "opus" } as const;
      const cited = { ...claimed, threadId: ThreadId.make("reviewer") };
      yield* evidence.record(
        recordInput("unnamed", [change("a", { branch: "feat-a", review: claimed })], { landedAt }),
      );
      yield* evidence.record(
        recordInput("cited", [change("a", { branch: "feat-a", review: cited })], { landedAt }),
      );
      assert.deepStrictEqual(
        [...(yield* reviewsOf("unnamed")), ...(yield* reviewsOf("cited"))],
        [
          { ...claimed, check: "unverified" },
          { ...cited, check: "unverified", thread: "reviewer" },
        ],
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a reviewer link when the lead's own child records the landing", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* seedThread({ id: "impl", parent: "lead", role: "implementation" });
      yield* seedThread({ id: "reviewer", parent: "lead", role: "review" });
      const cited = { verdict: "approved", threadId: ThreadId.make("reviewer") } as const;
      yield* evidence.record(
        recordInput("by-child", [change("own", { review: cited })], {
          threadId: ThreadId.make("impl"),
          landedAt,
        }),
      );
      assert.deepStrictEqual(yield* reviewsOf("by-child"), [
        { ...cited, check: "unverified", thread: "reviewer" },
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("reads each linked thread's current state in one query when a landing is read", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread({ id: "lead" });
      const ids = ["idle", "relabelled", "archived", "deleted", "removed"];
      for (const id of ids) yield* seedThread({ id, parent: "lead", role: "review" });
      yield* evidence.record(
        recordInput(
          "states",
          ids.map((id) =>
            change(id, { review: { verdict: "approved", threadId: ThreadId.make(id) } }),
          ),
          { landedAt },
        ),
      );
      // Threads change after the landing: a role edit, an archive, a soft delete and a hard delete.
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.delegateRole', 'implementation')
        WHERE thread_id = 'relabelled'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${landedAt} WHERE thread_id = 'archived'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${landedAt} WHERE thread_id = 'deleted'`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'removed'`;
      const reviews = yield* reviewsOf("states");
      assert.deepStrictEqual(
        reviews.map((review) => [String(review.threadId), review.thread]),
        [
          ["idle", "reviewer"],
          ["relabelled", "other"],
          ["archived", "archived"],
          ["deleted", "missing"],
          ["removed", "missing"],
        ],
      );
      // The state is read, never stored.
      const [row] = yield* sql<{ readonly record_json: string }>`SELECT record_json FROM
        evidence_landings WHERE landing_id = 'states'`;
      assert.notInclude(row!.record_json, '"thread"');
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("drops a cited reviewer whose thread was deleted", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread({ id: "lead" });
      yield* seedThread({ id: "reviewer", parent: "lead", role: "review" });
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${landedAt}
        WHERE thread_id = 'reviewer'`;
      const result = yield* evidence.record(
        recordInput(
          "deleted",
          [change("a", { review: { verdict: "approved", threadId: ThreadId.make("reviewer") } })],
          { landedAt },
        ),
      );
      assert.deepStrictEqual(result.warnings, [
        "change a: dropped review.threadId reviewer because it is not a thread this lead delegated",
      ]);
      assert.deepStrictEqual(yield* reviewsOf("deleted"), [
        { verdict: "approved", check: "unverified" },
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("drops a cited reviewer that runs in a linked environment", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      // A remote delegate's task carries no local child thread.
      yield* seedTask({
        taskId: "remote-review",
        parent: "lead",
        child: null,
        role: "review",
        prompt: "Review feat-remote.",
        result: "Verdict: approved",
      });
      const result = yield* evidence.record(
        recordInput(
          "remote",
          [
            change("remote", {
              review: { verdict: "approved", threadId: ThreadId.make("remote") },
            }),
          ],
          { landedAt },
        ),
      );
      assert.lengthOf(result.warnings, 1);
      assert.deepStrictEqual(yield* reviewsOf("remote"), [
        { verdict: "approved", check: "unverified" },
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it("requires a reason to waive review or skip a check, not to waive QA, and keeps old records readable", () => {
  const base = recordInput("reasons", [change("a")]);
  const { threadId: _threadId, projectId: _projectId, ...input } = base;
  assert.isTrue(decodeRecord(input)._tag === "Success");

  const waived = { ...input, changes: [change("a", { review: { verdict: "waived" } })] };
  const waivedExit = decodeRecord(waived);
  assert.isTrue(waivedExit._tag === "Failure");
  assert.include(String(waivedExit), 'Change "a" waives review; give review.reason in one line.');
  assert.isTrue(
    decodeRecord({
      ...input,
      changes: [change("a", { review: { verdict: "waived", reason: "One-line fix." } })],
    })._tag === "Success",
  );

  const skipped = { ...input, verifications: [{ label: "e2e", result: "skipped" }] };
  const skippedExit = decodeRecord(skipped);
  assert.isTrue(skippedExit._tag === "Failure");
  assert.include(String(skippedExit), 'Verification "e2e" is skipped; give a one-line reason.');
  assert.isTrue(
    decodeRecord({
      ...input,
      verifications: [{ label: "e2e", result: "skipped", reason: "No browser here." }],
    })._tag === "Success",
  );

  // The user waives QA in one click; a note is optional.
  assert.isTrue(
    decodeQa({ landingId: "reasons", changeId: "a", state: "waived" })._tag === "Success",
  );

  // Agents cannot claim the server's check or a linked thread's state.
  const decoded = decodeRecord({
    ...input,
    changes: [
      { ...change("a"), review: { verdict: "approved", check: "verified", thread: "reviewer" } },
    ],
  });
  assert.isTrue(decoded._tag === "Success");
  if (decoded._tag === "Success")
    assert.deepStrictEqual(decoded.value.changes?.[0]?.review, { verdict: "approved" });

  // A client built before the linked thread's state existed reads a change carrying it.
  const olderClientChange = decodeChange({
    ...change("a"),
    review: { verdict: "approved", threadId: "reviewer", thread: "reviewer" },
  });
  assert.isTrue(olderClientChange._tag === "Success");

  // A stored record from before reasons were required still decodes.
  const stored = decodeStoredRecord({
    ...input,
    verifications: [{ label: "e2e", result: "skipped" }],
    changes: [change("a", { review: { verdict: "waived" } })],
  });
  assert.isTrue(stored._tag === "Success");
});

it.effect("lists a skipped check's reason and leaves it off checks without one", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* evidence.record(
        recordInput("checks", [change("a")], {
          verifications: [
            { label: "unit", result: "pass" },
            { label: "e2e", result: "skipped", reason: "No browser here." },
          ],
        }),
      );
      const { items } = yield* evidence.list({});
      assert.deepStrictEqual(items[0]?.verifications, [
        { label: "unit", result: "pass" },
        { label: "e2e", result: "skipped", reason: "No browser here." },
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it("raises QA for each reason on its own and records a change with none quietly", () => {
  const verified = { verdict: "approved", check: "verified" } as const;
  const base = { captures: [], gaps: [], review: verified };
  const pass = [{ label: "gate", result: "pass" }] as const;
  const capture = { path: "/home/u/evidence/a.png", caption: "After" };
  const cases = [
    [base, pass, []],
    [{ ...base, captures: [capture] }, pass, ["captures"]],
    [{ ...base, review: { verdict: "waived", reason: "Docs." } }, pass, ["review_waived"]],
    // Every claim is unverified, so an approval alone raises nothing.
    [{ ...base, review: { verdict: "approved", check: "unverified" } }, pass, []],
    [
      { ...base, review: { verdict: "changes_requested", check: "verified" } },
      pass,
      ["review_changes_requested"],
    ],
    [base, [{ label: "unit", result: "fail" }], ["check_failed"]],
    [base, [{ label: "e2e", result: "skipped", reason: "No display." }], ["check_skipped"]],
    [{ ...base, gaps: ["Not run on Safari."] }, pass, ["gaps"]],
  ] as const;
  for (const [change, verifications, reasons] of cases)
    assert.deepStrictEqual(Service.qaRaiseReasons(change, verifications), reasons);
});

it.effect("records an approval alone quietly, recomputes reasons and keeps the user's answer", () =>
  withHome((_home, root) =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const approvedOnly = { gaps: [] };
      const captured = change("a", {
        ...approvedOnly,
        captures: [{ path: `${root}/a.png`, caption: "After" }],
      });
      const first = yield* evidence.record(
        recordInput("batch-1", [captured, change("b", approvedOnly)]),
      );
      assert.deepStrictEqual(
        first.changes.map((item) => [item.qa, item.raised, item.ref]),
        [
          ["pending", ["captures"], 1],
          ["quiet", [], undefined],
        ],
      );
      yield* evidence.setQa({ landingId: "batch-1", changeId: "a", state: "confirmed" });
      const again = yield* evidence.record(
        recordInput("batch-1", [
          change("a", approvedOnly),
          change("b", { gaps: ["Not on Safari."] }),
          change("c", { ...approvedOnly, review: { verdict: "changes_requested" } }),
        ]),
      );
      assert.deepStrictEqual(
        again.changes.map((item) => [item.qa, item.raised, item.ref]),
        [
          ["confirmed", [], 1],
          ["pending", ["gaps"], 2],
          ["pending", ["review_changes_requested"], 3],
        ],
      );
      const landing = yield* evidence.get({ landingId: "batch-1" });
      assert.deepStrictEqual(
        landing.changes.map(({ qa }) => [qa.state, qa.by, qa.raised]),
        [
          ["confirmed", "user", []],
          ["pending", "server", ["gaps"]],
          ["pending", "server", ["review_changes_requested"]],
        ],
      );
      // A pending change with nothing left to check goes quiet when it is recorded again.
      const quieter = yield* evidence.record(
        recordInput("batch-1", [change("a", approvedOnly), change("b", approvedOnly)]),
      );
      assert.deepStrictEqual(
        quieter.changes.map((item) => item.qa),
        ["confirmed", "quiet"],
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("shows a delegated child's or grandchild's landing in its lead's thread", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* seedThread({ id: "child", parent: "lead", role: "implementation" });
      yield* seedThread({ id: "grandchild", parent: "child", role: "implementation" });
      yield* seedThread({ id: "other-lead" });
      for (const [id, threadId] of [
        ["by-lead", "lead"],
        ["by-child", "child"],
        ["by-grandchild", "grandchild"],
        ["elsewhere", "other-lead"],
      ] as const)
        yield* evidence.record(
          recordInput(id, [change(`${id}-1`)], { threadId: ThreadId.make(threadId), landedAt }),
        );
      const qaThreads = (yield* evidence.thread({ threadId: lead })).landings.map((landing) => [
        landing.id,
        landing.threadId,
        landing.qaThreadId,
        landing.changes[0]!.qa.ref,
      ]);
      assert.deepStrictEqual(qaThreads, [
        ["by-lead", "lead", "lead", 1],
        ["by-grandchild", "grandchild", "lead", 3],
        ["by-child", "child", "lead", 2],
      ]);
      // The child's own thread still lists its landing, which points at the lead.
      assert.deepStrictEqual(
        (yield* evidence.thread({ threadId: ThreadId.make("child") })).landings.map((landing) => [
          landing.id,
          landing.qaThreadId,
        ]),
        [["by-child", "lead"]],
      );
      assert.strictEqual(
        (yield* evidence.get({ landingId: "elsewhere" })).qaThreadId,
        "other-lead",
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

/** Seeds the thread's running turn and the messages it took as input. */
const seedRunInput = (
  threadId: string,
  messages: ReadonlyArray<{ readonly id: string; readonly payload: Record<string, unknown> }>,
  status = "running",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = `run-${threadId}`;
    const ids = messages.map((message) => message.id);
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, 1, 'codex', ${status}, ${landedAt},
        ${JSON.stringify({ userMessageId: ids[0], inputMessageIds: ids })})`;
    for (const message of messages)
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${message.id}, ${threadId}, ${runId}, 'user', 0, ${landedAt}, ${landedAt}, ${JSON.stringify(message.payload)})`;
  });

it.effect("lets an agent settle QA only from a user's own message in its current turn", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const refuse = (threadId: string) =>
        errorOf(
          evidence.agentSetQa({
            threadId: ThreadId.make(threadId),
            landingId: `landing-${threadId}`,
            changeId: "a",
            state: "confirmed",
          }),
        );
      const cases = [
        ["system", { createdBy: "system", origin: { kind: "system", event: "evidence prompt" } }],
        ["brief", { createdBy: "agent", senderThreadId: "lead-thread" }],
        ["agent-written", { createdBy: "agent", origin: { kind: "user" } }],
        [
          "scheduled",
          {
            createdBy: "user",
            origin: { kind: "scheduled-task", title: "Nightly" },
            scheduledTaskId: "task-1",
          },
        ],
      ] as const;
      for (const [threadId, payload] of cases) {
        yield* seedThread({ id: threadId });
        yield* evidence.record(
          recordInput(`landing-${threadId}`, [change("a")], { threadId: ThreadId.make(threadId) }),
        );
        yield* seedRunInput(threadId, [{ id: `message-${threadId}`, payload }]);
        assert.strictEqual(yield* refuse(threadId), Service.AGENT_QA_NEEDS_USER_MESSAGE);
      }
      // A user message in a finished run no longer counts.
      yield* seedThread({ id: "finished" });
      yield* evidence.record(
        recordInput("landing-finished", [change("a")], { threadId: ThreadId.make("finished") }),
      );
      yield* seedRunInput(
        "finished",
        [{ id: "message-finished", payload: { createdBy: "user" } }],
        "completed",
      );
      assert.strictEqual(yield* refuse("finished"), Service.AGENT_QA_NEEDS_USER_MESSAGE);

      yield* seedThread({ id: "user" });
      yield* evidence.record(
        recordInput("landing-user", [change("a")], { threadId: ThreadId.make("user") }),
      );
      yield* seedRunInput("user", [
        {
          id: "message-wake",
          payload: { createdBy: "system", origin: { kind: "wake", detail: "x" } },
        },
        { id: "message-user", payload: { createdBy: "user", origin: { kind: "user" } } },
      ]);
      const recorded = yield* evidence.agentSetQa({
        threadId: ThreadId.make("user"),
        landingId: "landing-user",
        changeId: "a",
        state: "problem",
        note: "The count overlaps the close button.",
      });
      assert.deepStrictEqual(
        [recorded.state, recorded.by, recorded.messageId, recorded.note],
        ["problem", "agent", "message-user", "The count overlaps the close button."],
      );
      assert.deepStrictEqual(yield* qaCounts, { pending: 5, problem: 1 });
      // Another thread's QA is settled in that thread.
      assert.strictEqual(
        yield* errorOf(
          evidence.agentSetQa({
            threadId: ThreadId.make("user"),
            landingId: "landing-system",
            changeId: "a",
            state: "confirmed",
          }),
        ),
        "Landing landing-system shows its QA in another thread; settle it there.",
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("closes an agent's problem when a later landing names it in fixes", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* evidence.record(recordInput("first", [change("toast")]));
      yield* seedRunInput("lead", [{ id: "message-1", payload: { createdBy: "user" } }]);
      yield* evidence.agentSetQa({
        threadId: lead,
        landingId: "first",
        changeId: "toast",
        state: "problem",
        note: "Overlaps the button.",
      });
      const fix = yield* evidence.record(
        recordInput("second", [
          change("toast-fix", { fixes: [{ landingId: "first", changeId: "toast" }] }),
          change("other", { fixes: [{ landingId: "first", changeId: "missing" }] }),
        ]),
      );
      assert.deepStrictEqual(fix.changes[0], {
        id: "toast-fix",
        qa: "pending",
        raised: ["gaps"],
        ref: 2,
      });
      assert.deepStrictEqual(fix.warnings, [
        "change other: fixes first/missing, which is not a recorded problem",
      ]);
      const closed = (yield* evidence.get({ landingId: "first" })).changes[0]!.qa;
      assert.deepInclude(closed, {
        state: "waived",
        by: "agent",
        note: "Fixed by second · toast-fix",
      });
      assert.deepStrictEqual(yield* qaCounts, { pending: 2, problem: 0 });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("marks pending changes discussed until the user or agent next acts on them", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* evidence.record(recordInput("first", [change("a"), change("b")]));
      yield* evidence.setQa({ landingId: "first", changeId: "b", state: "confirmed" });
      yield* evidence.markDiscussed({
        threadId: lead,
        messageId: MessageId.make("message-discuss"),
        changes: [
          { landingId: "first", changeId: "a" },
          { landingId: "first", changeId: "b" },
        ],
      });
      const discussed = () =>
        evidence
          .get({ landingId: "first" })
          .pipe(Effect.map((landing) => landing.changes.map((item) => item.qa.discussedMessageId)));
      assert.deepStrictEqual(yield* discussed(), ["message-discuss", undefined]);
      // Another thread's message never marks this thread's changes.
      yield* evidence.markDiscussed({
        threadId: ThreadId.make("other"),
        messageId: MessageId.make("message-other"),
        changes: [{ landingId: "first", changeId: "a" }],
      });
      assert.deepStrictEqual(yield* discussed(), ["message-discuss", undefined]);
      yield* evidence.setQa({ landingId: "first", changeId: "a", state: "pending" });
      assert.deepStrictEqual(yield* discussed(), [undefined, undefined]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("reads a stored reason this build no longer raises by dropping it", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const sql = yield* SqlClient.SqlClient;
      yield* evidence.record(recordInput("older", [change("a")]));
      yield* sql`UPDATE evidence_qa SET raised_json = '["review_unverified","gaps"]' WHERE landing_id = 'older'`;
      const qa = (yield* evidence.get({ landingId: "older" })).changes[0]!.qa;
      assert.deepStrictEqual([qa.state, qa.raised], ["pending", ["gaps"]]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps a card for a change that waited from before reasons were kept once it is answered",
  () =>
    withHome(() =>
      Effect.gen(function* () {
        const evidence = yield* Service.EvidenceService;
        const sql = yield* SqlClient.SqlClient;
        yield* evidence.record(recordInput("older", [change("waiting"), change("settled")]));
        // As migration 115 leaves rows from before reasons were kept.
        yield* sql`UPDATE evidence_qa SET raised_json = NULL WHERE landing_id = 'older'`;
        yield* sql`UPDATE evidence_qa SET state = 'confirmed' WHERE change_id = 'settled'`;
        yield* evidence.setQa({ landingId: "older", changeId: "waiting", state: "confirmed" });
        yield* evidence.setQa({ landingId: "older", changeId: "settled", state: "waived" });
        const raised = (yield* evidence.get({ landingId: "older" })).changes.map((item) => [
          item.id,
          item.qa.state,
          item.qa.raised,
        ]);
        assert.deepStrictEqual(raised, [
          ["waiting", "confirmed", ["legacy"]],
          ["settled", "waived", undefined],
        ]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("leaves an agent's record to the agent unless the user changes its state", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* evidence.record(recordInput("first", [change("a"), change("b")]));
      yield* seedRunInput("lead", [{ id: "message-1", payload: { createdBy: "user" } }]);
      yield* evidence.agentSetQa({
        threadId: lead,
        landingId: "first",
        changeId: "a",
        state: "dismissed",
        note: "The user said the old flow is gone.",
      });
      assert.strictEqual(
        yield* errorOf(
          evidence.setQa({ landingId: "first", changeId: "a", state: "waived", note: "Mine now" }),
        ),
        "The agent recorded this; reopen it to change it.",
      );
      const kept = (yield* evidence.get({ landingId: "first" })).changes[0]!.qa;
      assert.deepStrictEqual(
        [kept.by, kept.messageId, kept.note],
        ["agent", "message-1", "The user said the old flow is gone."],
      );
      // The user's own note edit keeps it theirs, and reopening takes over the agent's record.
      yield* evidence.setQa({ landingId: "first", changeId: "b", state: "waived" });
      const own = yield* evidence.setQa({
        landingId: "first",
        changeId: "b",
        state: "waived",
        note: "Covered by CI.",
      });
      assert.deepStrictEqual([own.by, own.note], ["user", "Covered by CI."]);
      const reopened = yield* evidence.setQa({
        landingId: "first",
        changeId: "a",
        state: "pending",
      });
      assert.deepStrictEqual([reopened.by, reopened.messageId], ["user", undefined]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("leaves a change the user is discussing out of what waits on them", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* evidence.record(recordInput("first", [change("a")]));
      yield* evidence.record(recordInput("second", [change("b")]));
      assert.deepStrictEqual(yield* qaCounts, { pending: 2, problem: 0 });
      yield* evidence.markDiscussed({
        threadId: lead,
        messageId: MessageId.make("message-discuss"),
        changes: [{ landingId: "first", changeId: "a" }],
      });
      assert.deepStrictEqual(yield* qaCounts, { pending: 1, problem: 0 });
      assert.deepStrictEqual(
        (yield* evidence.list({ needsQa: true })).items.map((item) => item.id),
        ["second"],
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reads the landings a timeline places even when they are older than the newest page",
  () =>
    withHome(() =>
      Effect.gen(function* () {
        const evidence = yield* Service.EvidenceService;
        for (let index = 0; index < 52; index++) {
          const minute = String(index).padStart(2, "0");
          yield* evidence.record(
            recordInput(`landing-${minute}`, [change("a")], {
              landedAt: `2026-11-20T10:${minute}:00.000Z`,
            }),
          );
        }
        yield* evidence.record(
          recordInput("elsewhere", [change("a")], { threadId: ThreadId.make("other") }),
        );
        const newest = yield* evidence.thread({ threadId: lead });
        assert.strictEqual(newest.landings.length, 50);
        assert.isFalse(newest.landings.some((landing) => landing.id === "landing-00"));
        const placed = yield* evidence.thread({
          threadId: lead,
          landingIds: ["landing-00", "landing-51", "elsewhere"],
        });
        assert.strictEqual(placed.landings.length, 51);
        assert.strictEqual(placed.landings.at(-1)!.id, "landing-00");
        assert.isFalse(placed.landings.some((landing) => landing.id === "elsewhere"));
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "lists the changes still waiting in a thread and names the thread each time one moves",
  () =>
    withHome(() =>
      Effect.gen(function* () {
        const evidence = yield* Service.EvidenceService;
        yield* seedThread({ id: "lead" });
        yield* seedThread({ id: "child", parent: "lead", role: "implementation" });
        const moved = yield* Queue.unbounded<ThreadId>();
        yield* Stream.runForEach(evidence.qaThreadChanges, (threadId) =>
          Queue.offer(moved, threadId),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const child = ThreadId.make("child");
        yield* evidence.record(
          recordInput("by-child", [change("a"), change("b"), change("c")], {
            threadId: child,
            landedAt,
          }),
        );
        // An approval with no gaps raises nothing, so it never waits.
        yield* evidence.record(
          recordInput("quiet", [change("d", { gaps: [] })], { threadId: lead, landedAt }),
        );
        assert.deepStrictEqual(yield* Queue.takeAll(moved), [lead, lead]);
        yield* evidence.setQa({ landingId: "by-child", changeId: "a", state: "confirmed" });
        yield* evidence.markDiscussed({
          threadId: lead,
          messageId: MessageId.make("m1"),
          changes: [{ landingId: "by-child", changeId: "c" }],
        });
        assert.deepStrictEqual(yield* Queue.takeAll(moved), [lead, lead]);
        // Only an agent records a problem, from the user's message in its turn.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE evidence_qa SET state = 'problem', by = 'agent'
          WHERE landing_id = 'by-child' AND change_id = 'b'`;
        assert.deepStrictEqual(yield* evidence.waitingQa(lead), [
          { kind: "qa", ref: "QA2", key: "by-child/b", title: "Changed b", state: "problem" },
          { kind: "qa", ref: "QA3", key: "by-child/c", title: "Changed c", state: "discussing" },
        ]);
        assert.deepStrictEqual(yield* evidence.waitingQa(child), []);
        assert.deepStrictEqual(yield* evidence.waitingQaThreads(), [lead]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

const instant = (iso: string) => DateTime.makeUnsafe(iso);
const decodeBulk = Schema.decodeUnknownSync(EvidenceBulkSetQaInput);
const decodeBulkExit = Schema.decodeUnknownExit(EvidenceBulkSetQaInput);

it.effect("dismisses only what still waits for QA before a date, as the user, in one pass", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const sql = yield* SqlClient.SqlClient;
      const other = ThreadId.make("other-lead");
      yield* seedThread({ id: "lead" });
      yield* seedThread({ id: "other-lead" });
      const old = "2026-11-01T10:00:00.000Z";
      yield* evidence.record(
        recordInput(
          "old-lead",
          [change("pending"), change("discussed"), change("fixing"), change("checked")],
          { landedAt: old },
        ),
      );
      yield* evidence.record(
        recordInput("old-quiet", [change("quiet", { gaps: [] })], { landedAt: old }),
      );
      yield* evidence.record(
        recordInput("old-other", [change("legacy")], { threadId: other, landedAt: old }),
      );
      yield* evidence.record(
        recordInput("new-lead", [change("recent")], { landedAt: "2026-11-25T10:00:00.000Z" }),
      );
      yield* evidence.markDiscussed({
        threadId: lead,
        messageId: MessageId.make("m1"),
        changes: [{ landingId: "old-lead", changeId: "discussed" }],
      });
      yield* evidence.setQa({ landingId: "old-lead", changeId: "checked", state: "confirmed" });
      yield* sql`UPDATE evidence_qa SET state = 'problem', by = 'agent'
        WHERE landing_id = 'old-lead' AND change_id = 'fixing'`;
      // A change from before raise reasons were kept.
      yield* sql`UPDATE evidence_qa SET raised_json = NULL
        WHERE landing_id = 'old-other' AND change_id = 'legacy'`;
      const before = instant("2026-11-20T00:00:00.000Z");
      const note = "backlog cleared, not individually checked";

      const preview = yield* evidence.bulkSetQa({ before, dryRun: true });
      assert.deepStrictEqual(preview, {
        count: 2,
        changes: [
          { landingId: "old-lead", changeId: "pending" },
          { landingId: "old-other", changeId: "legacy" },
        ],
      });
      assert.strictEqual(
        (yield* Effect.flip(
          evidence.bulkSetQa({ before, note: "   ", changes: preview.changes ?? [] }),
        )).code,
        "invalid",
      );
      assert.deepStrictEqual(yield* qaCounts, { pending: 3, problem: 1 });

      const moved = yield* Queue.unbounded<ThreadId>();
      yield* Stream.runForEach(evidence.qaThreadChanges, (threadId) =>
        Queue.offer(moved, threadId),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(
        yield* evidence.bulkSetQa({ before, note, changes: preview.changes ?? [] }),
        { count: 2 },
      );
      // Each thread whose changes moved is rebuilt once, however many of its changes moved.
      assert.sameMembers([...(yield* Queue.takeAll(moved))], [lead, other]);

      const qa = new Map(
        (yield* sql<{
          readonly change_id: string;
          readonly state: string;
          readonly by: string;
          readonly note: string;
          readonly raised_json: string | null;
        }>`SELECT change_id, state, by, note, raised_json FROM evidence_qa`).map((row) => [
          row.change_id,
          row,
        ]),
      );
      assert.deepInclude(qa.get("pending"), { state: "waived", by: "user", note });
      assert.deepInclude(qa.get("legacy"), {
        state: "waived",
        by: "user",
        note,
        raised_json: '["legacy"]',
      });
      assert.strictEqual(qa.get("discussed")?.state, "pending");
      assert.strictEqual(qa.get("fixing")?.state, "problem");
      assert.deepInclude(qa.get("checked"), { state: "confirmed", by: "user" });
      assert.strictEqual(qa.get("quiet")?.state, "quiet");
      assert.strictEqual(qa.get("recent")?.state, "pending");
      assert.deepStrictEqual(yield* evidence.bulkSetQa({ before, dryRun: true }), {
        count: 0,
        changes: [],
      });
      // A dismissed card keeps Reopen.
      const reopened = yield* evidence.setQa({
        landingId: "old-lead",
        changeId: "pending",
        state: "pending",
      });
      assert.strictEqual(reopened.state, "pending");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("dismisses only the listed changes still waiting, never ones that joined since", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* evidence.record(
        recordInput("old", [change("a"), change("b"), change("c")], {
          landedAt: "2026-11-01T10:00:00.000Z",
        }),
      );
      yield* evidence.setQa({ landingId: "old", changeId: "c", state: "confirmed" });
      const before = instant("2026-11-20T00:00:00.000Z");
      const preview = yield* evidence.bulkSetQa({ before, dryRun: true });
      assert.deepStrictEqual(
        preview.changes?.map((key) => key.changeId),
        ["a", "b"],
      );
      // Between the list and the confirmation, c is reopened and b is discussed.
      yield* evidence.setQa({ landingId: "old", changeId: "c", state: "pending" });
      yield* evidence.markDiscussed({
        threadId: lead,
        messageId: MessageId.make("m1"),
        changes: [{ landingId: "old", changeId: "b" }],
      });
      assert.deepStrictEqual(
        yield* evidence.bulkSetQa({
          before,
          note: "backlog cleared",
          changes: preview.changes ?? [],
        }),
        { count: 1 },
      );
      const states = (yield* evidence.get({ landingId: "old" })).changes.map((item) => [
        item.id,
        item.qa.state,
      ]);
      assert.deepStrictEqual(states, [
        ["a", "waived"],
        ["b", "pending"],
        ["c", "pending"],
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("compares the cutoff as an instant, however it is written", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      yield* seedThread({ id: "lead" });
      yield* evidence.record(
        recordInput("at-cutoff", [change("at")], { landedAt: "2026-11-26T07:00:00.000Z" }),
      );
      yield* evidence.record(
        recordInput("just-before", [change("before")], {
          landedAt: "2026-11-26T06:59:59.999Z",
        }),
      );
      const listed = (before: string) =>
        evidence
          .bulkSetQa(decodeBulk({ before, dryRun: true }))
          .pipe(Effect.map((result) => result.changes?.map((key) => key.changeId)));
      // The same instant, with and without milliseconds; a landing exactly at it stays.
      assert.deepStrictEqual(yield* listed("2026-11-26T07:00:00.000Z"), ["before"]);
      assert.deepStrictEqual(yield* listed("2026-11-26T07:00:00Z"), ["before"]);
      assert.deepStrictEqual(yield* listed("2026-11-26T00:00:00-07:00"), ["before"]);
      for (const before of ["zzz", "", "2026-13-45T99:00:00Z"])
        assert.isTrue(Exit.isFailure(decodeBulkExit({ before, dryRun: true })), before);
    }),
  ).pipe(Effect.provide(testLayer)),
);
