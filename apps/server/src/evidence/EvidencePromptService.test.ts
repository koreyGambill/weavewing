import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EVIDENCE_PROMPT_ORIGIN_EVENT,
  EventId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { deliverEvidencePrompt } from "./EvidencePromptDelivery.ts";
import * as EvidenceService from "./EvidenceService.ts";
import * as Service from "./EvidencePromptService.ts";

const project = ProjectId.make("project-1");
const lead = ThreadId.make("lead");
const child = ThreadId.make("child");
const MERGED_AT = "2026-02-01T00:00:00Z";
const at = (iso: string) => DateTime.makeUnsafe(iso);

interface RunFixture {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly inputs: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

/** What the mocked thread store holds, what the service sent through it, and a hook into Git work. */
const world = {
  runs: new Map<string, RunFixture>(),
  archived: new Set<string>(),
  sendFails: false,
  sent: [] as Array<ThreadManagement.ThreadManagementSendInput>,
  receipts: new Set<string>(),
  duringGit: Effect.void as Effect.Effect<void, never, EvidenceService.EvidenceService>,
};

const settingsRef = Ref.makeUnsafe({ evidencePromptEnabled: true });

/** The real evidence service, with `duringGit` run after the Git reads and before the claim. */
const layerEvidence = Layer.effect(
  EvidenceService.EvidenceService,
  Effect.gen(function* () {
    const real = yield* EvidenceService.EvidenceService;
    return {
      ...real,
      landedMoves: (input) =>
        real
          .landedMoves(input)
          .pipe(
            Effect.tap(() =>
              world.duringGit.pipe(Effect.provideService(EvidenceService.EvidenceService, real)),
            ),
          ),
    } satisfies EvidenceService.EvidenceService["Service"];
  }),
).pipe(Layer.provide(EvidenceService.layer));

const testLayer = Service.layer.pipe(
  Layer.provideMerge(layerEvidence),
  Layer.provideMerge(EffectOutbox.layer),
  Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provideMerge(VcsProcess.layer))),
  Layer.provideMerge(
    Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-evidence-prompt-" }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(settingsRef).pipe(Effect.map((settings) => settings as never)),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getRunInputMessages: (_threadId, runId) =>
          Effect.succeed(world.runs.get(runId)?.inputs ?? []),
        getThreadRecords: (threadId, _fields, filter) =>
          Effect.succeed({
            thread: {
              projectId: project,
              archivedAt: world.archived.has(threadId) ? at(MERGED_AT) : null,
              deletedAt: null,
            },
            turnItems: world.runs.get(filter?.turnItemRunId ?? "")?.items ?? [],
          } as never),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: (input) =>
          world.sendFails || world.archived.has(input.threadId)
            ? Effect.die(new Error("send refused"))
            : Effect.sync(() => {
                world.sent.push(input);
                world.receipts.add(input.commandId);
              }).pipe(Effect.as({} as never)),
        hasReceipt: (commandId) => Effect.sync(() => world.receipts.has(commandId)),
      }),
    ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);

/** A repository whose main fast-forwarded to two older feature commits at MERGED_AT. */
const landedRepo = Effect.gen(function* () {
  world.runs.clear();
  world.archived.clear();
  world.sendFails = false;
  world.sent = [];
  world.receipts.clear();
  world.duringGit = Effect.void;
  yield* Ref.set(settingsRef, { evidencePromptEnabled: true });
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-prompt-repo-" }));
  const git = (args: ReadonlyArray<string>, date = "2026-01-01T00:00:00Z") =>
    driver
      .execute({
        operation: "test",
        cwd: repo,
        args,
        env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const commit = (message: string) =>
    git(["commit", "-q", "--allow-empty", "-m", message]).pipe(
      Effect.andThen(git(["rev-parse", "HEAD"])),
    );
  yield* git(["init", "-q", "-b", "main"]);
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@test.com"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ] as const)
    yield* git(["config", key, value]);
  const base = yield* commit("base");
  yield* git(["checkout", "-q", "-b", "feature"]);
  const first = yield* commit("first");
  const second = yield* commit("second");
  yield* git(["checkout", "-q", "main"]);
  yield* git(["merge", "-q", "--ff-only", "feature"], MERGED_AT);
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${project}, 'Repo', ${repo}, '[]', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`;
  return { repo, git, base, first, second };
});

interface CommandFixture {
  readonly input: string;
  readonly status?: "completed" | "failed";
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly seconds?: number;
  readonly output?: string;
}

const command = (
  threadId: ThreadId,
  runId: RunId,
  fixture: CommandFixture,
): OrchestrationV2TurnItem => {
  const startedAt = at(fixture.startedAt ?? MERGED_AT);
  return {
    id: TurnItemId.make(`${runId}:${fixture.input}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: fixture.status ?? "completed",
    title: null,
    startedAt,
    completedAt: DateTime.add(startedAt, { milliseconds: (fixture.seconds ?? 2) * 1000 }),
    updatedAt: startedAt,
    type: "command_execution",
    input: fixture.input,
    ...(fixture.output === undefined ? {} : { output: fixture.output }),
    ...(fixture.exitCode === undefined ? {} : { exitCode: fixture.exitCode }),
  };
};

/**
 * Stores a run with its commands and input messages, as the thread store and the projection tables
 * other threads' evaluations read, and returns the event its end raises.
 */
const ranTurn = (
  id: string,
  commands: ReadonlyArray<CommandFixture>,
  options: {
    readonly threadId?: ThreadId;
    readonly status?: OrchestrationV2Run["status"];
    readonly inputs?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = RunId.make(id);
    const threadId = options.threadId ?? lead;
    const run = {
      id: runId,
      threadId,
      status: options.status ?? "completed",
      startedAt: at("2026-01-31T23:00:00Z"),
      completedAt: at("2026-02-01T01:00:00Z"),
    } as OrchestrationV2Run;
    const items = commands.map((fixture) => command(threadId, runId, fixture));
    world.runs.set(runId, { threadId, items, inputs: options.inputs ?? [] });
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (thread_id, project_id, title,
        default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, ${project}, ${threadId}, 'codex', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z', '{}')`;
    for (const item of items) {
      if (item.type !== "command_execution") continue;
      const iso = (value: DateTime.Utc | null) =>
        value === null ? null : DateTime.formatIso(value);
      yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${item.id}, ${threadId}, ${runId}, 1, 'command_execution', ${item.status},
          ${iso(item.completedAt) ?? "2026-12-31T00:00:00.000Z"}, ${JSON.stringify({
            input: item.input,
            output: item.output,
            status: item.status,
            exitCode: item.exitCode,
            startedAt: iso(item.startedAt),
            completedAt: iso(item.completedAt),
          })})`;
    }
    return {
      type: "run.updated",
      id: EventId.make(`event:${id}`),
      threadId,
      runId,
      occurredAt: at("2026-02-01T01:00:00Z"),
      payload: run,
    } as OrchestrationV2DomainEvent;
  });

const promptMessage = (messageId: string) =>
  ({
    id: MessageId.make(messageId),
    origin: { kind: "system", event: EVIDENCE_PROMPT_ORIGIN_EVENT },
    createdBy: "system",
  }) as OrchestrationV2ConversationMessage;

const prompts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly target_sha: string;
    readonly thread_id: string;
    readonly outcome: string;
  }>`SELECT target_sha, thread_id, outcome FROM evidence_prompts ORDER BY move, position`;
});

/** The delivery effects claims queued, as the effect worker would run them. */
const deliveries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly command_id: string;
    readonly thread_id: string;
    readonly payload_json: string;
  }>`SELECT command_id, thread_id, payload_json FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'evidence-prompt.deliver' ORDER BY created_at`;
  return rows.map((row) => ({
    commandId: CommandId.make(row.command_id),
    threadId: ThreadId.make(row.thread_id),
    request: JSON.parse(row.payload_json) as Extract<
      EffectOutbox.OrchestrationEffectRequestV2,
      { readonly type: "evidence-prompt.deliver" }
    >,
  }));
});

const deliverAll = (willRetry = true) =>
  Effect.gen(function* () {
    for (const delivery of yield* deliveries)
      yield* deliverEvidencePrompt(delivery, { willRetry }).pipe(Effect.exit);
  });

it.effect("claims a landing with its delivery in one step and sends it once", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const { first, second } = yield* landedRepo;
    const landed = yield* ranTurn("run-1", [
      { input: "git status" },
      { input: "/bin/zsh -lc 'git merge --ff-only feature && git log -1'" },
    ]);
    yield* service.handle(landed);
    // The claim is owed, not yet sent: the effect worker delivers it.
    assert.deepStrictEqual(world.sent, []);
    assert.deepStrictEqual(
      (yield* prompts).map(({ target_sha, outcome }) => [target_sha, outcome]),
      [
        [second, "sent"],
        [first, "sent"],
      ],
    );
    const id = `evidence-prompt:${lead}:${second}`;
    const [delivery, extra] = yield* deliveries;
    assert.isUndefined(extra);
    assert.strictEqual(delivery?.commandId, id);

    // A replay after the message committed finds its receipt: it sends nothing more, and the
    // claim stays delivered even though the setting has since been turned off.
    yield* deliverAll();
    yield* Ref.set(settingsRef, { evidencePromptEnabled: false });
    yield* deliverAll();
    assert.strictEqual(world.sent.length, 1);
    assert.deepStrictEqual(
      (yield* prompts).map(({ outcome }) => outcome),
      ["sent", "sent"],
    );
    yield* Ref.set(settingsRef, { evidencePromptEnabled: true });
    for (const sent of world.sent)
      assert.deepStrictEqual(
        {
          commandId: sent.commandId,
          messageId: sent.messageId,
          origin: sent.origin,
          createdBy: sent.createdBy,
          mode: sent.mode,
          text: sent.text,
        },
        {
          commandId: id,
          messageId: MessageId.make(id),
          origin: { kind: "system", event: EVIDENCE_PROMPT_ORIGIN_EVENT },
          createdBy: "system",
          mode: "queue",
          text: `Work landed on main in your last turn (${second.slice(0, 7)}, ${first.slice(0, 7)}) and no evidence covers it. Call evidence_record for it, or evidence_record with exempt.reason to say why none is needed.`,
        },
      );

    // The same run ending again, or another run that saw the same move, claims nothing more.
    yield* service.handle(landed);
    yield* service.handle(yield* ranTurn("run-2", [{ input: "git merge feature" }]));
    assert.strictEqual((yield* deliveries).length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("asks only one thread about a commit, whichever claims it first", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    yield* landedRepo;
    yield* service.handle(
      yield* ranTurn("child-run", [{ input: "git merge feature" }], { threadId: child }),
    );
    // The lead's skipped merge ran in the same second as the child's real one.
    yield* service.handle(
      yield* ranTurn("lead-run", [{ input: "false && git merge feature; true" }]),
    );
    assert.deepStrictEqual(
      (yield* deliveries).map((delivery) => delivery.threadId),
      [child],
    );
    assert.deepStrictEqual([...new Set((yield* prompts).map((row) => row.thread_id))], [child]);
  }).pipe(Effect.provide(testLayer)),
);

/** Fast-forwards main to a new commit on a `next` branch at `date`, and returns it. */
const nextMove = (git: Effect.Success<typeof landedRepo>["git"], date: string) =>
  Effect.gen(function* () {
    yield* git(["checkout", "-q", "-b", "next"]);
    yield* git(["commit", "-q", "--allow-empty", "-m", "next"]);
    const third = yield* git(["rev-parse", "HEAD"]);
    yield* git(["checkout", "-q", "main"]);
    yield* git(["merge", "-q", "--ff-only", "next"], date);
    return third;
  }).pipe(Effect.orDie);

it.effect("a thread whose landing step did not run never wins the claim", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const { base, second } = yield* landedRepo;
    // The lead's merge was skipped, though its input succeeded in the second the child merged.
    yield* service.handle(
      yield* ranTurn("lead-skipped", [{ input: "false && git merge feature; true" }]),
    );
    // An output that reports another move does not tie a chained step to this one.
    yield* service.handle(
      yield* ranTurn("lead-other", [
        {
          input: "git fetch; git merge feature",
          output: "Updating 1111111..2222222\nFast-forward",
        },
      ]),
    );
    assert.deepStrictEqual(yield* deliveries, []);
    yield* service.handle(
      yield* ranTurn("child-land", [{ input: "git merge feature" }], { threadId: child }),
    );
    assert.deepStrictEqual(
      (yield* deliveries).map((delivery) => delivery.threadId),
      [child],
    );
    // A chained step whose own output reports the move is tied to it.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM evidence_prompts`;
    yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
    yield* service.handle(
      yield* ranTurn("lead-reported", [
        {
          input: "git fetch; git merge feature",
          output: `Updating ${base.slice(0, 7)}..${second.slice(0, 7)}\nFast-forward`,
        },
      ]),
    );
    assert.deepStrictEqual(
      (yield* deliveries).map((delivery) => delivery.threadId),
      [lead],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("asks nobody when two threads could each have made the move", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    yield* landedRepo;
    const childRun = yield* ranTurn("child-land", [{ input: "git merge feature" }], {
      threadId: child,
    });
    const leadRun = yield* ranTurn("lead-land", [{ input: "git merge feature" }]);
    yield* service.handle(leadRun);
    yield* service.handle(childRun);
    assert.deepStrictEqual(yield* deliveries, []);
    assert.deepStrictEqual(yield* prompts, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ties a step to the project only through a directory it can resolve", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const { repo, git } = yield* landedRepo;
    // A nested repository with its own merge in the same second as the project's.
    yield* git(["init", "-q", "-b", "main", "nested"]);
    const nested = (args: ReadonlyArray<string>, date = "2026-01-01T00:00:00Z") =>
      driver.execute({
        operation: "test",
        cwd: `${repo}/nested`,
        args: [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@test.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    yield* nested(["commit", "-q", "--allow-empty", "-m", "nested base"]);
    yield* nested(["checkout", "-q", "-b", "feature"]);
    yield* nested(["commit", "-q", "--allow-empty", "-m", "nested feature"]);
    yield* nested(["checkout", "-q", "main"]);
    yield* nested(["merge", "-q", "--ff-only", "feature"], MERGED_AT);
    yield* service.handle(
      yield* ranTurn("nested", [{ input: "cd nested && git merge --ff-only feature" }]),
    );
    yield* service.handle(
      yield* ranTurn("nested-absolute", [
        { input: `cd ${repo} && cd nested && git merge --ff-only feature` },
      ]),
    );
    assert.deepStrictEqual(yield* deliveries, []);
    // A relative step from a known absolute directory resolves to the project.
    const parent = repo.slice(0, repo.lastIndexOf("/"));
    const name = repo.slice(repo.lastIndexOf("/") + 1);
    yield* service.handle(
      yield* ranTurn("resolved", [{ input: `cd ${parent} && cd ${name} && git merge feature` }]),
    );
    assert.strictEqual((yield* deliveries).length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a pull that refreshes the branch is not a landing", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const { git } = yield* landedRepo;
    yield* git(["checkout", "-q", "-b", "pulled"]);
    yield* git(["commit", "-q", "--allow-empty", "-m", "pulled"]);
    const pulled = yield* git(["rev-parse", "HEAD"]);
    yield* git(["checkout", "-q", "main"]);
    yield* git(
      ["update-ref", "-m", "pull --ff-only: Fast-forward", "refs/heads/main", pulled],
      "2026-02-01T00:20:00Z",
    );
    const at20 = "2026-02-01T00:20:00Z";
    yield* service.handle(
      yield* ranTurn("pr-merge", [{ input: "gh pr merge 12 --squash", startedAt: at20 }]),
    );
    yield* service.handle(
      yield* ranTurn("merge", [{ input: "git merge pulled", startedAt: at20 }]),
    );
    assert.deepStrictEqual(yield* deliveries, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("each reflog entry is its own move, even two in one shell item", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const evidence = yield* EvidenceService.EvidenceService;
    const { git, first, second } = yield* landedRepo;
    const third = yield* nextMove(git, "2026-02-01T00:00:01Z");
    yield* evidence.record({
      id: "next",
      title: "Next move",
      target: { branch: "main", sha: third },
      verifications: [],
      exempt: { reason: "Nothing to check." },
      threadId: lead,
      projectId: project,
    });
    yield* service.handle(
      yield* ranTurn("two-moves", [
        { input: "git merge --ff-only feature && git merge --ff-only next" },
      ]),
    );
    assert.deepStrictEqual(
      (yield* prompts).map((row) => row.target_sha),
      [second, first],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a commit already asked about leaves a new landing in the same run to claim", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const { git, first, second } = yield* landedRepo;
    yield* service.handle(yield* ranTurn("run-1", [{ input: "git merge feature" }]));
    const third = yield* nextMove(git, "2026-02-01T00:00:10Z");
    yield* service.handle(
      yield* ranTurn("run-2", [
        { input: "git merge feature" },
        { input: "git merge next", startedAt: "2026-02-01T00:00:10Z" },
      ]),
    );
    assert.deepStrictEqual(
      (yield* prompts).map((row) => row.target_sha).toSorted(),
      [first, second, third].toSorted(),
    );
    assert.strictEqual((yield* deliveries).length, 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a run that was asked once is not asked again about later moves", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const evidence = yield* EvidenceService.EvidenceService;
    const { git, second } = yield* landedRepo;
    yield* service.handle(yield* ranTurn("same-run", [{ input: "git merge feature" }]));
    yield* evidence.record({
      id: "first-move",
      title: "First move",
      target: { branch: "main", sha: second },
      verifications: [],
      exempt: { reason: "Nothing to check." },
      threadId: lead,
      projectId: project,
    });
    yield* nextMove(git, MERGED_AT);
    yield* service.handle(yield* ranTurn("same-run", [{ input: "git merge next" }]));
    assert.strictEqual((yield* deliveries).length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("claims nothing when evidence for the commits is recorded during the Git work", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const { second } = yield* landedRepo;
    world.duringGit = Effect.gen(function* () {
      const evidence = yield* EvidenceService.EvidenceService;
      yield* evidence.record({
        id: "recorded-meanwhile",
        title: "Recorded meanwhile",
        target: { branch: "main", sha: second },
        verifications: [],
        exempt: { reason: "Nothing to check." },
        threadId: lead,
        projectId: project,
      });
    }).pipe(Effect.orDie);
    yield* service.handle(yield* ranTurn("run-1", [{ input: "git merge feature" }]));
    assert.deepStrictEqual(yield* prompts, []);
    assert.deepStrictEqual(yield* deliveries, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records per commit how the answering run answered, within the project", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const evidence = yield* EvidenceService.EvidenceService;
    const sql = yield* SqlClient.SqlClient;
    const { first, second } = yield* landedRepo;
    yield* service.handle(yield* ranTurn("run-1", [{ input: "git merge feature" }]));
    const [delivery] = yield* deliveries;
    const answer = (id: string) =>
      ranTurn(id, [{ input: "git merge feature" }], {
        inputs: [promptMessage(delivery!.request.messageId)],
      });
    const record = (id: string, sha: string, extra: Partial<EvidenceService.RecordInput>) =>
      evidence.record({
        id,
        title: id,
        target: { branch: "main", sha },
        verifications: [],
        threadId: lead,
        projectId: project,
        ...extra,
      });
    const change = (commits: ReadonlyArray<string>) => ({
      id: "a",
      ask: "Ship it",
      commits,
      summary: "Shipped",
      review: { verdict: "approved" as const },
      captures: [],
      gaps: [],
    });

    // A landing in another project that names the same commit answers nothing here.
    yield* record("elsewhere", second, {
      projectId: ProjectId.make("project-2"),
      changes: [change([second])],
    });
    // A change naming only the older commit answers that commit, not the batch.
    yield* record("older-only", first.slice(0, 7), { changes: [change([first])] });
    yield* service.handle(yield* answer("run-answer"));
    assert.deepStrictEqual(
      (yield* prompts).map(({ target_sha, outcome }) => [target_sha, outcome]),
      [
        [second, "ignored"],
        [first, "recorded"],
      ],
    );
    assert.deepStrictEqual(yield* deliveries, [delivery]);

    // An exemption whose target is the newest commit answers the whole move.
    yield* sql`UPDATE evidence_prompts SET outcome = 'sent'`;
    yield* sql`DELETE FROM evidence_landings`;
    yield* record("exempt", second.slice(0, 7), { exempt: { reason: "Nothing to check." } });
    yield* service.handle(yield* answer("run-answer-2"));
    assert.deepStrictEqual(
      (yield* prompts).map(({ outcome }) => outcome),
      ["exempt", "exempt"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("writes no claim when its delivery cannot be queued with it", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const sql = yield* SqlClient.SqlClient;
    yield* landedRepo;
    // Without the outbox table, queuing the delivery fails.
    yield* sql`DROP TABLE orchestration_v2_effect_outbox`;
    yield* service.handle(yield* ranTurn("run-1", [{ input: "git merge feature" }]));
    assert.deepStrictEqual(yield* prompts, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a landing's target covers only the older commits of its own ref move", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const evidence = yield* EvidenceService.EvidenceService;
    const { git, first, second } = yield* landedRepo;
    yield* git(["checkout", "-q", "feature"]);
    const third = yield* git(["commit", "-q", "--allow-empty", "-m", "third"]).pipe(
      Effect.andThen(git(["rev-parse", "HEAD"])),
    );
    yield* git(["checkout", "-q", "main"]);
    yield* git(["merge", "-q", "--ff-only", "feature"], "2026-02-01T00:00:10Z");
    yield* evidence.record({
      id: "third",
      title: "Third",
      target: { branch: "main", sha: third },
      verifications: [],
      exempt: { reason: "Nothing to check." },
      threadId: lead,
      projectId: project,
    });
    yield* service.handle(
      yield* ranTurn("run-1", [
        { input: "git merge feature" },
        { input: "git merge feature", startedAt: "2026-02-01T00:00:10Z" },
      ]),
    );
    assert.deepStrictEqual(
      (yield* prompts).map((row) => row.target_sha),
      [second, first],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("claims nothing when the run, its commands or the thread rule a prompt out", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const evidence = yield* EvidenceService.EvidenceService;
    const { repo, git, first, second } = yield* landedRepo;
    const merge = "git merge feature";
    // Main moved forward by a reset, which no landing command leaves, inside a merge's window.
    yield* git(["checkout", "-q", "-b", "elsewhere"]);
    const extra = yield* git(["commit", "-q", "--allow-empty", "-m", "extra"]).pipe(
      Effect.andThen(git(["rev-parse", "HEAD"])),
    );
    yield* git(["checkout", "-q", "main"]);
    yield* git(["reset", "-q", "--hard", extra], "2026-02-01T00:10:00Z");
    const cases: ReadonlyArray<[string, OrchestrationV2DomainEvent]> = [
      ["failed run", yield* ranTurn("failed", [{ input: merge }], { status: "failed" })],
      [
        "interrupted run",
        yield* ranTurn("interrupted", [{ input: merge }], { status: "interrupted" }),
      ],
      ["no landing command", yield* ranTurn("status", [{ input: "git status && git log -3" }])],
      ["failed command", yield* ranTurn("exit-1", [{ input: merge, exitCode: 1 }])],
      [
        "failed Claude command",
        yield* ranTurn("claude-failed", [{ input: merge, status: "failed" }]),
      ],
      [
        "command that ended before the move's second",
        yield* ranTurn("before", [
          { input: merge, startedAt: "2026-01-31T23:59:58.000Z", seconds: 1.5 },
        ]),
      ],
      [
        "command that started after the move's second",
        yield* ranTurn("after", [{ input: merge, startedAt: "2026-02-01T00:00:01.000Z" }]),
      ],
      [
        "a move no landing command made",
        yield* ranTurn("reset", [{ input: merge, startedAt: "2026-02-01T00:10:00Z" }]),
      ],
      ["merging main into a checkout", yield* ranTurn("refresh", [{ input: "git merge main" }])],
      [
        "a merge of another branch than the move's",
        yield* ranTurn("other-source", [{ input: "git merge other-branch" }]),
      ],
      ["push to another branch", yield* ranTurn("push", [{ input: "git push origin feature" }])],
      ["text naming a command", yield* ranTurn("echo", [{ input: "echo 'git merge feature'" }])],
      [
        "a merge in another repository",
        yield* ranTurn("other-repo", [{ input: "git -C /tmp merge feature" }]),
      ],
    ];
    for (const [name, event] of cases) {
      yield* service.handle(event);
      assert.deepStrictEqual(yield* deliveries, [], name);
    }

    world.archived.add(lead);
    yield* service.handle(yield* ranTurn("archived", [{ input: merge }]));
    assert.deepStrictEqual(yield* deliveries, [], "archived thread");
    world.archived.clear();

    yield* Ref.set(settingsRef, { evidencePromptEnabled: false });
    yield* service.handle(yield* ranTurn("setting-off", [{ input: merge }]));
    assert.deepStrictEqual(yield* deliveries, [], "setting off");
    yield* Ref.set(settingsRef, { evidencePromptEnabled: true });

    yield* evidence.record({
      id: "covered",
      title: "Covered",
      target: { branch: "main", sha: second },
      verifications: [],
      changes: [
        {
          id: "a",
          ask: "Ship it",
          commits: [first, second],
          summary: "Shipped",
          review: { verdict: "approved" },
          captures: [],
          gaps: [],
        },
      ],
      threadId: lead,
      projectId: project,
    });
    yield* service.handle(yield* ranTurn("covered", [{ input: `git -C ${repo} merge feature` }]));
    assert.deepStrictEqual(yield* deliveries, [], "covered landing");
    assert.deepStrictEqual(yield* prompts, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "withdraws a claim the thread or setting rules out by delivery, and marks a give-up",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.EvidencePromptService;
      yield* landedRepo;
      yield* service.handle(yield* ranTurn("run-1", [{ input: "git merge feature" }]));
      const outcomes = prompts.pipe(Effect.map((rows) => rows.map((row) => row.outcome)));

      // A failed attempt that will be retried leaves the prompt owed.
      world.sendFails = true;
      const [delivery] = yield* deliveries;
      const failed = yield* deliverEvidencePrompt(delivery!, { willRetry: true }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      assert.deepStrictEqual(yield* outcomes, ["sent", "sent"]);
      yield* deliverAll(false);
      assert.deepStrictEqual(yield* outcomes, ["failed", "failed"]);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE evidence_prompts SET outcome = 'sent'`;
      world.sendFails = false;
      world.archived.add(lead);
      yield* deliverAll();
      assert.deepStrictEqual(yield* outcomes, ["cancelled", "cancelled"]);

      yield* sql`UPDATE evidence_prompts SET outcome = 'sent'`;
      world.archived.clear();
      yield* Ref.set(settingsRef, { evidencePromptEnabled: false });
      yield* deliverAll();
      assert.deepStrictEqual(yield* outcomes, ["cancelled", "cancelled"]);
      assert.deepStrictEqual(world.sent, []);
    }).pipe(Effect.provide(testLayer)),
);

it("matches landing commands on what the shell runs", () => {
  const target = { branch: "main", remote: "origin" };
  const kinds = (input: string) => Service.landingSteps(input, target).map((step) => step.kind);
  const lands: ReadonlyArray<[string, string]> = [
    ["git merge feature", "merge"],
    ["git -c core.editor=true merge --no-ff -m 'Merge feature' feature", "merge"],
    ["git merge --continue", "merge"],
    ["cd /home/user/app && GIT_EDITOR=true git merge feature", "merge"],
    ["(git merge feature)", "merge"],
    ["git push origin HEAD:main", "push"],
    ["git push origin 'HEAD:main'", "push"],
    ["env X=1 git push origin HEAD:main", "push"],
    ["git push origin +feature:refs/heads/main", "push"],
    ["git push -u origin main", "push"],
    ["xwing env land --repo app", "land"],
    [`/bin/zsh -lc "git merge feature"`, "merge"],
  ];
  const doesNot = [
    "git merge origin/main",
    "git merge --ff-only upstream/main",
    "git merge --ff-only main",
    "git merge FETCH_HEAD",
    "git merge --abort",
    "git merge --no-commit feature",
    "git merge",
    "git merge-base main feature",
    "git push origin feature",
    "git push other HEAD:main",
    "git push",
    "git push --dry-run origin main",
    "git push origin --delete main",
    // A forge merge leaves no local move to tie it to.
    "gh pr merge 12 --squash",
    "gh pr view 12",
    "xwing env land --dry-run",
    "xwing env land --delivery pull-request",
    "xwing env land --delivery=pull-request",
    "sparkwing run land",
    `${["su", "do"].join("")} git push origin HEAD:main`,
    "echo 'gh pr merge 12'",
    "echo 'done && git merge feature'",
    "git commit -m 'git merge feature'",
    "cat <<END-OF-TEXT\ngit merge feature\nEND-OF-TEXT",
    "cat <<'EOF'\ngit push origin HEAD:main\nEOF",
    "cat <<'END-OF-TEXT'\ngit merge feature\nEND-OF-TEXT",
    "# git merge feature",
    // A relative directory from the thread's checkout cannot be resolved.
    "cd nested && git merge feature",
    "pushd nested && git merge feature",
    "git -C ../other merge feature",
    "cd /home/user/app && popd && git merge feature",
  ];
  for (const [input, kind] of lands) assert.deepStrictEqual(kinds(input), [kind], input);
  for (const input of doesNot) assert.deepStrictEqual(kinds(input), [], input);
  const step = (input: string) =>
    Service.landingSteps(input, target).map(({ kind, sources, dir, proven }) => ({
      kind,
      sources,
      dir,
      proven,
    }));
  assert.deepStrictEqual(step("git -C /home/user/other merge feature"), [
    { kind: "merge", sources: ["feature"], dir: "/home/user/other", proven: true },
  ]);
  assert.deepStrictEqual(step("cd /home/user/app && cd sub && git merge --ff-only feature"), [
    { kind: "merge", sources: ["feature"], dir: "/home/user/app/sub", proven: true },
  ]);
  assert.deepStrictEqual(step("cd /home/user/app && git -C ../other push origin HEAD:main"), [
    { kind: "push", sources: [], dir: "/home/user/other", proven: true },
  ]);
  // Only an all-`&&` chain shows from the input's success that the step ran.
  assert.deepStrictEqual(step("false && git merge feature; true"), [
    { kind: "merge", sources: ["feature"], dir: null, proven: false },
  ]);
  assert.deepStrictEqual(step("git push origin HEAD:main || true"), [
    { kind: "push", sources: [], dir: null, proven: false },
  ]);
});
