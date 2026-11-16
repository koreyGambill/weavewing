import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EvidenceRecordInput,
  ProjectId,
  ThreadId,
  type EvidenceChange,
  type NotificationStreamEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
/** Counts the coverage check's git runs and can mark their output truncated. */
const gitProbe = { calls: 0, truncate: false };
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
  gaps: [],
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
  recordedBy: lead,
  ...extra,
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
        assert.deepStrictEqual(first.changes, [
          { id: "a", qa: "pending" },
          { id: "b", qa: "pending" },
        ]);
        yield* evidence.setQa({
          landingId: "batch-1",
          changeId: "a",
          state: "failed",
          note: "Broken",
        });
        yield* evidence.setQa({ landingId: "batch-1", changeId: "b", state: "confirmed" });
        assert.deepStrictEqual(yield* evidence.counts(), { pending: 0, failed: 1 });

        const again = yield* evidence.record(recordInput("batch-1", [change("a"), change("c")]));
        assert.deepStrictEqual(again.changes, [
          { id: "a", qa: "failed" },
          { id: "c", qa: "pending" },
        ]);
        const landing = yield* evidence.get({ landingId: "batch-1" });
        assert.deepStrictEqual(
          landing.changes.map((item) => [item.id, item.qa.state, item.qa.note]),
          [
            ["a", "failed", "Broken"],
            ["c", "pending", ""],
          ],
        );
        assert.deepStrictEqual(yield* evidence.counts(), { pending: 1, failed: 1 });

        // Another thread reusing the id is refused, so it can neither take the landing nor reset QA.
        const other = ThreadId.make("other");
        for (const changes of [[change("x")], [change("a"), change("c")]]) {
          const error = yield* Effect.flip(
            evidence.record(
              recordInput("batch-1", changes, { threadId: other, recordedBy: other }),
            ),
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
          ["failed", "pending"],
        );
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "walks QA through every state, keeps notes unless replaced, and refuses unknown ids",
  () =>
    withHome(() =>
      Effect.gen(function* () {
        const evidence = yield* Service.EvidenceService;
        yield* evidence.record(recordInput("batch-1", [change("a")]));
        const states = ["confirmed", "failed", "waived", "pending", "failed"] as const;
        for (const state of states) {
          const qa = yield* evidence.setQa({ landingId: "batch-1", changeId: "a", state });
          assert.strictEqual(qa.state, state);
        }
        yield* evidence.setQa({ landingId: "batch-1", changeId: "a", state: "failed", note: "x" });
        const kept = yield* evidence.setQa({
          landingId: "batch-1",
          changeId: "a",
          state: "waived",
        });
        assert.strictEqual(kept.note, "x");
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
        qa: { pending: 2, confirmed: 0, failed: 0, waived: 0 },
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
  const valid = { ...recordInput("ok", [change("a")]), recordedBy: undefined };
  assert.isTrue(decode(valid)._tag === "Success");
  for (const bad of [
    { ...valid, changes: [] },
    { ...valid, id: "has space" },
    { ...valid, changes: [change("a", { commits: ["not-a-sha"] })] },
    { ...valid, changes: Array.from({ length: 21 }, (_, index) => change(`c${index}`)) },
  ])
    assert.isTrue(decode(bad)._tag === "Failure");
});

it.effect("raises one Inbox notification per landing, only when new changes need QA", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      const notifications = yield* NotificationService.NotificationService;
      const events = yield* Queue.unbounded<NotificationStreamEvent>();
      yield* Stream.runForEach(notifications.subscribe(), (event) =>
        Queue.offer(events, event),
      ).pipe(Effect.forkScoped);
      assert.strictEqual((yield* Queue.take(events)).items.length, 0);

      yield* evidence.record(
        recordInput("batch-1", [change("a", { ticket: { key: "BW-1" } }), change("b")]),
      );
      const raised = yield* Queue.take(events);
      assert.deepStrictEqual(
        raised.items.map(({ title, body, source, threadId, projectId, repeatCount }) => ({
          title,
          body,
          source,
          threadId,
          projectId,
          repeatCount,
        })),
        [
          {
            title: "Landed 2 changes – QA waiting on 2",
            body: "Landing batch-1\n- BW-1: Ask for a\n- b: Ask for b",
            source: { kind: "agent", threadId: lead },
            threadId: lead,
            projectId: project,
            repeatCount: 0,
          },
        ],
      );
      const id = raised.items[0]!.id;

      // Same changes again: nothing new to QA, so the Inbox stays quiet.
      yield* evidence.record(recordInput("batch-1", [change("a"), change("b")]));
      yield* notifications.update({ ids: [id], action: { type: "read" } });
      const read = yield* Queue.take(events);
      assert.strictEqual(read.items[0]!.repeatCount, 0);

      // A new change updates the same Inbox item rather than adding one.
      yield* evidence.record(recordInput("batch-1", [change("a"), change("b"), change("c")]));
      const repeat = yield* Queue.take(events);
      assert.strictEqual(repeat.items[0]!.id, id);
      assert.strictEqual(repeat.items[0]!.repeatCount, 1);
      assert.strictEqual(repeat.items[0]!.title, "Landed 3 changes – QA waiting on 3");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("records even when the Inbox refuses, and says so", () =>
  withHome(() =>
    Effect.gen(function* () {
      const evidence = yield* Service.EvidenceService;
      for (let index = 0; index < NotificationService.RATE_LIMIT_PER_HOUR; index++)
        yield* evidence.record(recordInput(`batch-${index}`, [change("a")]));
      const result = yield* evidence.record(recordInput("one-more", [change("a")]));
      assert.strictEqual(result.warnings.length, 1);
      assert.match(result.warnings[0]!, /^inbox notification skipped: At most 10/);
      assert.strictEqual((yield* evidence.get({ landingId: "one-more" })).id, "one-more");
    }),
  ).pipe(Effect.provide(testLayer)),
);

/** A scratch repository registered as `project`, with fixed dates so its commit ids never change. */
const scratchRepo = Effect.gen(function* () {
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
    VALUES (${project}, 'Repo', ${repo}, '[]', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`;
  gitProbe.calls = 0;
  gitProbe.truncate = false;
  return { repo, git, commit, merge, base: yield* commit("base") };
});

it.effect("flags merges on the target branch that no landing covers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const evidence = yield* Service.EvidenceService;
    const { repo, git, commit, merge, base } = yield* scratchRepo;
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

it.effect("treats truncated git output as a failure and retries it after the TTL", () =>
  Effect.gen(function* () {
    const evidence = yield* Service.EvidenceService;
    const { merge, base } = yield* scratchRepo;
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
    const { git, merge, base } = yield* scratchRepo;
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
