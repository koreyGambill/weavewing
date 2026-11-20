import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Execution is paused after dispatch for transfer inspection"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "delegated-context-fork" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const createThread = (threadId: ThreadId, projectId = "context-fork-project") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make(projectId),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

/** A completed, checkpointed run on a strong native provider thread. */
const writeFinishedRun = (threadId: ThreadId, runId: RunId, ordinal: number) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`${runId}:provider-thread`);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${runId}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: `${runId}:native`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: ordinal,
            lastRunOrdinal: ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`${runId}:message`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: CheckpointId.make(`${runId}:checkpoint`),
            contextHandoffId: null,
          },
        },
      ],
    });
  });

const startTurn = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      origin: { kind: "user" as const },
      commandId: CommandId.make(`${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

type DelegateCommand = Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>;

const delegate = (
  parentThreadId: ThreadId,
  task: string,
  extra: Partial<Pick<DelegateCommand, "contextSource" | "workspaceStrategy">> = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
      ...extra,
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const childThreadId = parent.subagents.find((task_) => task_.prompt === task)!.childThreadId!;
    return yield* orchestrator.getThreadProjection(childThreadId);
  });

const transferSummary = (
  child: Orchestrator.OrchestratorV2["Service"] extends never
    ? never
    : {
        readonly contextTransfers: ReadonlyArray<{
          readonly type: string;
          readonly sourceThreadId: ThreadId;
          readonly sourcePoint: { readonly runId?: RunId | undefined };
          readonly status: string;
        }>;
      },
) =>
  child.contextTransfers
    .map(
      (transfer) =>
        `${transfer.type}:${transfer.sourceThreadId}:${transfer.sourcePoint.runId ?? "-"}:${transfer.status}`,
    )
    .toSorted();

it.effect("a delegated task starts fresh unless a context source is selected", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("fresh-parent");
    yield* createThread(parentId);
    yield* writeFinishedRun(parentId, RunId.make("fresh-parent-run-1"), 1);
    yield* startTurn(parentId, "lead");
    const child = yield* delegate(parentId, "review the diff");
    assert.deepStrictEqual(
      child.contextTransfers.map((transfer) => transfer.type),
      ["subagent_spawn"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a child forked from its busy supervisor gets portable context and keeps the supervisor as parent",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parentId = ThreadId.make("busy-parent");
      yield* createThread(parentId);
      yield* startTurn(parentId, "existing plan");
      const finished = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!.id;
      yield* writeFinishedRun(parentId, finished, 1);
      yield* startTurn(parentId, "lead");
      const leadRunId = (yield* orchestrator.getThreadProjection(parentId)).runs.at(-1)?.id;
      const child = yield* delegate(parentId, "continue with the plan", {
        contextSource: { threadId: parentId, point: { type: "latest_stable" } },
      });
      assert.strictEqual(child.thread.lineage.parentThreadId, parentId);
      assert.strictEqual(child.thread.lineage.relationshipToParent, "subagent");
      assert.deepStrictEqual(transferSummary(child), [
        `fork:${parentId}:${finished}:consumed`,
        `subagent_spawn:${parentId}:${leadRunId}:consumed`,
      ]);
      const fork = child.contextTransfers.find((transfer) => transfer.type === "fork");
      assert.strictEqual(fork?.targetRunId, child.runs[0]?.id);
      assert.strictEqual(fork?.resolution?.strategy, "portable_context");
      const inherited = yield* ContextHandoffService.readInheritedHandoffItems(
        {
          getForkSourceRewindOrdinal: () => Effect.die("Expected source without rewinds"),
          getThreadProjection: (threadId) =>
            orchestrator.getThreadProjection(threadId).pipe(Effect.orDie),
          getThreadRecords: (threadId, fields, filter) =>
            orchestrator.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
        },
        child.thread,
      );
      assert.deepStrictEqual(
        inherited.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
        ["existing plan"],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("workers forked from a scout share its pinned point after the scout moves on", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("fanout-parent");
    const scoutId = ThreadId.make("fanout-scout");
    const scoutFinal = RunId.make("fanout-scout-run-1");
    yield* createThread(parentId);
    yield* createThread(scoutId);
    yield* writeFinishedRun(scoutId, scoutFinal, 1);
    yield* startTurn(parentId, "lead");
    const first = yield* delegate(parentId, "worker one", {
      contextSource: { threadId: scoutId, point: { type: "latest_stable" } },
    });
    yield* writeFinishedRun(scoutId, RunId.make("fanout-scout-run-2"), 2);
    const second = yield* delegate(parentId, "worker two", {
      contextSource: {
        threadId: scoutId,
        point: { type: "run", runId: scoutFinal },
      },
    });
    for (const child of [first, second]) {
      const fork = child.contextTransfers.find((transfer) => transfer.type === "fork")!;
      assert.strictEqual(fork.sourceThreadId, scoutId);
      assert.strictEqual(fork.sourcePoint.runId, scoutFinal);
      // An idle same-provider source with a strong native thread forks natively at turn start.
      assert.strictEqual(fork.status, "pending");
      assert.strictEqual(fork.targetRunId, child.runs[0]!.id);
      assert.strictEqual(child.thread.lineage.parentThreadId, parentId);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("a worktree child keeps its context fork until its checkout is prepared", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("worktree-parent");
    const scoutId = ThreadId.make("worktree-scout");
    const scoutFinal = RunId.make("worktree-scout-run-1");
    yield* createThread(parentId);
    yield* createThread(scoutId);
    yield* writeFinishedRun(scoutId, scoutFinal, 1);
    yield* startTurn(parentId, "lead");
    const child = yield* delegate(parentId, "isolated worker", {
      contextSource: { threadId: scoutId, point: { type: "run", runId: scoutFinal } },
      workspaceStrategy: { type: "worktree", baseRef: "main" },
    });
    const run = child.runs[0];
    assert.strictEqual(run?.status, "preparing");
    assert.deepStrictEqual(run?.workspacePreparation, { type: "worktree", baseRef: "main" });
    const fork = child.contextTransfers.find((transfer) => transfer.type === "fork");
    assert.strictEqual(fork?.sourcePoint.runId, scoutFinal);
    assert.strictEqual(fork?.targetRunId, run?.id);
    assert.strictEqual(fork?.status, "pending");

    yield* orchestrator.dispatch({
      type: "prepared-run.release",
      commandId: CommandId.make("worktree-child-release"),
      threadId: child.thread.id,
      runId: run!.id,
    });
    const released = yield* orchestrator.getThreadProjection(child.thread.id);
    assert.strictEqual(released.runs[0]?.status, "starting");
    assert.strictEqual(
      released.contextTransfers.find((transfer) => transfer.type === "fork")?.status,
      "pending",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects context from another project or an unfinished run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("reject-parent");
    const otherId = ThreadId.make("reject-other-project");
    yield* createThread(parentId);
    yield* createThread(otherId, "other-project");
    yield* writeFinishedRun(otherId, RunId.make("reject-other-run-1"), 1);
    yield* startTurn(parentId, "lead");
    const activeRunId = (yield* orchestrator.getThreadProjection(parentId)).runs.at(-1)!.id;
    const failures = yield* Effect.forEach(
      [
        { threadId: otherId, point: { type: "latest_stable" } },
        { threadId: parentId, point: { type: "run", runId: activeRunId } },
      ] satisfies ReadonlyArray<NonNullable<DelegateCommand["contextSource"]>>,
      (contextSource, index) =>
        delegate(parentId, `rejected ${index}`, { contextSource }).pipe(
          Effect.flip,
          Effect.map((error) =>
            error._tag === "OrchestratorDispatchError" ? String(error.cause) : String(error),
          ),
        ),
    );
    assert.match(failures[0]!, /not a thread in this project/);
    assert.match(failures[1]!, /cannot be forked/);
    assert.deepStrictEqual((yield* orchestrator.getThreadProjection(parentId)).subagents, []);
  }).pipe(Effect.provide(layer)),
);
