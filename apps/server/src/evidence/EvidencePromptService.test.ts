import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EvidenceService from "./EvidenceService.ts";
import * as Service from "./EvidencePromptService.ts";

const project = ProjectId.make("project-1");
const lead = ThreadId.make("lead");
const MERGED_AT = "2026-02-01T00:00:00Z";
const at = (iso: string) => DateTime.makeUnsafe(iso);

interface RunFixture {
  readonly run: OrchestrationV2Run;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly inputs: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

/** What the mocked thread store holds and what the service sent through it. */
const world = {
  runs: new Map<string, RunFixture>(),
  archived: false,
  sent: [] as Array<ThreadManagement.ThreadManagementSendInput>,
};

const layerFor = (settings: { readonly evidencePromptEnabled: boolean }) =>
  Service.layer.pipe(
    Layer.provideMerge(EvidenceService.layer),
    Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provideMerge(VcsProcess.layer))),
    Layer.provideMerge(
      Layer.mergeAll(
        Sqlite.layerMemory,
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-evidence-prompt-" }),
        ServerSettings.ServerSettingsService.layerTest(settings),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRunInputMessages: (_threadId, runId) =>
            Effect.succeed(world.runs.get(runId)?.inputs ?? []),
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.succeed({
              thread: {
                projectId: project,
                archivedAt: world.archived ? at(MERGED_AT) : null,
                deletedAt: null,
              },
              turnItems: world.runs.get(filter?.turnItemRunId ?? "")?.items ?? [],
            } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.sync(() => world.sent.push(input)).pipe(Effect.as({} as never)),
        }),
      ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  );
const testLayer = layerFor({ evidencePromptEnabled: true });

/** A repository whose main fast-forwarded to two older feature commits at MERGED_AT. */
const landedRepo = Effect.gen(function* () {
  world.runs.clear();
  world.archived = false;
  world.sent = [];
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
  yield* commit("base");
  yield* git(["checkout", "-q", "-b", "feature"]);
  const first = yield* commit("first");
  const second = yield* commit("second");
  yield* git(["checkout", "-q", "main"]);
  yield* git(["merge", "-q", "--ff-only", "feature"], MERGED_AT);
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${project}, 'Repo', ${repo}, '[]', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`;
  return { first, second };
});

const command = (
  runId: RunId,
  input: string,
  options: {
    readonly status?: "completed" | "failed";
    readonly exitCode?: number;
    readonly startedAt?: string;
  } = {},
): OrchestrationV2TurnItem => {
  const startedAt = at(options.startedAt ?? MERGED_AT);
  return {
    id: TurnItemId.make(`${runId}:${input}`),
    threadId: lead,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: options.status ?? "completed",
    title: null,
    startedAt,
    completedAt: DateTime.add(startedAt, { seconds: 2 }),
    updatedAt: startedAt,
    type: "command_execution",
    input,
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
  };
};

/** Stores a run with its commands and input messages, and returns the event its end raises. */
const ranTurn = (
  id: string,
  commands: ReadonlyArray<{
    readonly input: string;
    readonly status?: "completed" | "failed";
    readonly exitCode?: number;
    readonly startedAt?: string;
  }>,
  options: {
    readonly status?: OrchestrationV2Run["status"];
    readonly inputs?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  } = {},
): OrchestrationV2DomainEvent => {
  const runId = RunId.make(id);
  const run = {
    id: runId,
    threadId: lead,
    status: options.status ?? "completed",
    startedAt: at("2026-01-31T23:00:00Z"),
    completedAt: at("2026-02-01T01:00:00Z"),
  } as OrchestrationV2Run;
  world.runs.set(runId, {
    run,
    items: commands.map(({ input, ...rest }) => command(runId, input, rest)),
    inputs: options.inputs ?? [],
  });
  return {
    type: "run.updated",
    id: EventId.make(`event:${id}`),
    threadId: lead,
    runId,
    occurredAt: at("2026-02-01T01:00:00Z"),
    payload: run,
  } as OrchestrationV2DomainEvent;
};

const promptMessage = (sent: ThreadManagement.ThreadManagementSendInput) =>
  ({
    id: sent.messageId,
    origin: sent.origin,
    createdBy: sent.createdBy,
  }) as OrchestrationV2ConversationMessage;

const prompts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly target_sha: string;
    readonly run_id: string;
    readonly outcome: string;
  }>`SELECT target_sha, run_id, outcome FROM evidence_prompts ORDER BY target_sha`;
});

it.effect("prompts once for an uncovered landing and never twice for the run or its commits", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const { first, second } = yield* landedRepo;
    const landed = ranTurn("run-1", [
      { input: "git status" },
      { input: "/bin/zsh -lc 'git merge --ff-only feature && git log -1'" },
    ]);
    yield* service.handle(landed);
    assert.strictEqual(world.sent.length, 1);
    const [sent] = world.sent;
    const id = `evidence-prompt:${lead}:${second}`;
    assert.deepStrictEqual(
      {
        commandId: sent?.commandId,
        messageId: sent?.messageId,
        origin: sent?.origin,
        createdBy: sent?.createdBy,
        mode: sent?.mode,
        text: sent?.text,
      },
      {
        commandId: id,
        messageId: MessageId.make(id),
        origin: { kind: "system", event: "evidence prompt" },
        createdBy: "system",
        mode: "queue",
        text: `Work landed on main in your last turn (${second.slice(0, 7)}, ${first.slice(0, 7)}) and no evidence covers it. Call evidence_record for it, or evidence_record with exempt.reason to say why none is needed.`,
      },
    );
    assert.deepStrictEqual(
      (yield* prompts).map(({ target_sha, outcome }) => [target_sha, outcome]),
      [first, second].toSorted().map((sha) => [sha, "sent"]),
    );

    // The same run ending again, or another run that saw the same move, sends nothing more.
    yield* service.handle(landed);
    yield* service.handle(ranTurn("run-2", [{ input: "gh pr merge 12 --squash" }]));
    assert.strictEqual(world.sent.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("never evaluates the run that answers a prompt, and records how it answered", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    yield* landedRepo;
    yield* service.handle(ranTurn("run-1", [{ input: "git merge --ff-only feature" }]));
    const [sent] = world.sent;
    assert.isDefined(sent);
    const answer = (id: string) =>
      ranTurn(id, [{ input: "git merge --ff-only feature" }], { inputs: [promptMessage(sent!)] });

    // An answer that records nothing is ignored, and the commits are never prompted for again.
    yield* service.handle(answer("run-answer"));
    assert.strictEqual(world.sent.length, 1);
    assert.deepStrictEqual(
      (yield* prompts).map(({ outcome }) => outcome),
      ["ignored", "ignored"],
    );
    yield* service.handle(ranTurn("run-later", [{ input: "git merge --ff-only feature" }]));
    assert.strictEqual(world.sent.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("marks a prompt recorded or exempt by what the answering run recorded", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const evidence = yield* EvidenceService.EvidenceService;
    const sql = yield* SqlClient.SqlClient;
    const { second } = yield* landedRepo;
    yield* service.handle(ranTurn("run-1", [{ input: "git merge --ff-only feature" }]));
    const [sent] = world.sent;
    const answer = ranTurn("run-answer", [], { inputs: [promptMessage(sent!)] });
    yield* evidence.record({
      id: "docs-only",
      title: "Docs only",
      target: { branch: "main", sha: second.slice(0, 7) },
      verifications: [],
      changes: [],
      exempt: { reason: "Docs-only change." },
      threadId: lead,
      projectId: project,
    });
    yield* service.handle(answer);
    assert.deepStrictEqual(
      (yield* prompts).map(({ outcome }) => outcome),
      ["exempt", "exempt"],
    );

    yield* sql`UPDATE evidence_prompts SET outcome = 'sent'`;
    yield* evidence.record({
      id: "docs-only",
      title: "Docs only",
      target: { branch: "main", sha: second },
      verifications: [],
      changes: [
        {
          id: "a",
          ask: "Fix the docs",
          commits: [second],
          summary: "Fixed",
          review: { verdict: "approved" },
          captures: [],
          gaps: [],
        },
      ],
      threadId: lead,
      projectId: project,
    });
    yield* service.handle(answer);
    assert.deepStrictEqual(
      (yield* prompts).map(({ outcome }) => outcome),
      ["recorded", "recorded"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("sends nothing when the run, its commands or the thread rule a prompt out", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    const evidence = yield* EvidenceService.EvidenceService;
    const { first, second } = yield* landedRepo;
    const merge = "git merge --ff-only feature";
    const cases: ReadonlyArray<[string, OrchestrationV2DomainEvent]> = [
      ["failed run", ranTurn("failed", [{ input: merge }], { status: "failed" })],
      ["interrupted run", ranTurn("interrupted", [{ input: merge }], { status: "interrupted" })],
      ["no landing command", ranTurn("status", [{ input: "git status && git log -3" }])],
      ["failed command", ranTurn("exit-1", [{ input: merge, exitCode: 1 }])],
      ["failed Claude command", ranTurn("claude-failed", [{ input: merge, status: "failed" }])],
      [
        "command that moved no branch",
        ranTurn("no-move", [{ input: merge, startedAt: "2026-01-15T00:00:00Z" }]),
      ],
      ["merging main into a checkout", ranTurn("refresh", [{ input: "git merge main" }])],
      ["push to another branch", ranTurn("push", [{ input: "git push origin feature" }])],
      ["text naming a command", ranTurn("echo", [{ input: "echo 'git merge feature'" }])],
    ];
    for (const [name, event] of cases) {
      yield* service.handle(event);
      assert.strictEqual(world.sent.length, 0, name);
    }

    world.archived = true;
    yield* service.handle(ranTurn("archived", [{ input: merge }]));
    assert.strictEqual(world.sent.length, 0, "archived thread");
    world.archived = false;

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
    yield* service.handle(ranTurn("covered", [{ input: merge }]));
    assert.strictEqual(world.sent.length, 0, "covered landing");
    assert.deepStrictEqual(yield* prompts, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("sends nothing while the setting is off", () =>
  Effect.gen(function* () {
    const service = yield* Service.EvidencePromptService;
    yield* landedRepo;
    yield* service.handle(ranTurn("run-1", [{ input: "git merge --ff-only feature" }]));
    assert.deepStrictEqual(world.sent, []);
  }).pipe(Effect.provide(layerFor({ evidencePromptEnabled: false }))),
);

it("matches landing commands on what the shell runs", () => {
  const target = { branch: "main", remote: "origin" };
  const lands = [
    "git merge feature",
    "git -C /home/user/app merge --no-ff -m 'Merge feature' feature",
    "git merge --continue",
    "cd /home/user/app && GIT_EDITOR=true git merge feature",
    "git push origin HEAD:main",
    "git push origin +feature:refs/heads/main",
    "git push -u origin main",
    "gh pr merge 12 --squash",
    "xwing env land --repo app",
    "sparkwing run land",
    `/bin/zsh -lc "git merge feature"`,
  ];
  const doesNot = [
    "git merge origin/main",
    "git merge --ff-only main",
    "git merge FETCH_HEAD",
    "git merge --abort",
    "git merge",
    "git merge-base main feature",
    "git push origin feature",
    "git push",
    "git push --dry-run origin main",
    "git push origin --delete main",
    "gh pr view 12",
    "xwing env land --dry-run",
    "echo 'gh pr merge 12'",
    "echo 'done && git merge feature'",
    "git commit -m 'git merge feature'",
  ];
  for (const input of lands) assert.isTrue(Service.isLandingCommand(input, target), input);
  for (const input of doesNot) assert.isFalse(Service.isLandingCommand(input, target), input);
});
