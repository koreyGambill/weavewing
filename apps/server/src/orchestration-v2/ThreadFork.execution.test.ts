import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (
  [
    ["codex", "interrupted"],
    ["claudeAgent", "failed"],
  ] as const
).map(([driverName, status]) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return { driver, status, instanceId, modelSelection, layer };
});

it.effect("a persisted fork leaves PR watching with its parent until explicitly opted in", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const sourceThreadId = ThreadId.make("fork-watch-source");
    const targetThreadId = ThreadId.make("fork-watch-target");
    const sourceRunId = RunId.make("fork-watch-source-run");
    const key = { host: "github.com", repository: "example/repo", number: 1 };
    const link = { url: "https://github.com/example/repo/pull/1", source: "agent" as const };

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-watch-create"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-watch-project"),
      title: "Watching source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-watch-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("fork-watch-source-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-parent-start"),
      threadId: sourceThreadId,
      ...key,
      watching: true,
      link,
    });
    const parentBefore = yield* orchestrator.getThreadShell(sourceThreadId);
    const parentWatch = parentBefore?.pullRequests?.[0]?.watch;
    assert.isDefined(parentWatch);
    assert.lengthOf(parentBefore?.pendingBackgroundTasks ?? [], 1);

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-watch-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const fork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isNotNull(fork);
    assert.deepEqual(fork.pullRequests, [
      {
        ...key,
        ...link,
        linkedAt: parentWatch.startedAt,
        snapshot: null,
        stack: null,
      },
    ]);
    assert.deepEqual(fork.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    const stale = yield* orchestrator
      .dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("fork-watch-stale-sync"),
        threadId: targetThreadId,
        ...key,
        startedAt: parentWatch.startedAt,
        watch: parentWatch,
        wake: {
          messageId: MessageId.make("fork-watch-unwanted-wake"),
          text: "A check failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "A check failed",
          },
        },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.deepEqual((yield* orchestrator.getThreadProjection(targetThreadId)).runs, []);

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-in"),
      threadId: targetThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchingFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isDefined(watchingFork?.pullRequests?.[0]?.watch);
    assert.notEqual(watchingFork.pullRequests[0].watch.startedAt, parentWatch.startedAt);
    assert.lengthOf(watchingFork.pendingBackgroundTasks ?? [], 1);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-out"),
      threadId: targetThreadId,
      ...key,
      watching: false,
    });
    const stoppedFork = yield* orchestrator.getThreadShell(targetThreadId);
    const [forkLink] = fork.pullRequests ?? [];
    assert.isDefined(forkLink);
    assert.deepEqual(stoppedFork?.pullRequests, [
      { ...forkLink, endedWatch: watchingFork.pullRequests[0].watch },
    ]);
    assert.deepEqual(stoppedFork?.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each(forkCases)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");
      const grandparentThreadId = ThreadId.make("fork-boundary-grandparent");
      const grandparentRunId = RunId.make("fork-boundary-grandparent-run");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-grandparent"),
        threadId: grandparentThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary grandparent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* writeParentRun({
        threadId: grandparentThreadId,
        runId: RunId.make("fork-boundary-grandparent-rolled-back-run"),
        ordinal: 1,
        status: "rolled_back",
        text: "ROLLED_BACK_MARKER",
      });
      yield* writeParentRun({
        threadId: grandparentThreadId,
        runId: grandparentRunId,
        ordinal: 2,
        status: "completed",
        text: "GRANDPARENT_MARKER",
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-grandparent"),
        sourceThreadId: grandparentThreadId,
        targetThreadId: sourceThreadId,
        sourcePoint: { type: "run", runId: grandparentRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 2,
              lastRunOrdinal: 3,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      yield* writeParentRun({
        threadId: sourceThreadId,
        runId: RunId.make("fork-boundary-source-rolled-back-run"),
        ordinal: 1,
        status: "rolled_back",
        text: "SOURCE_ROLLED_BACK_MARKER",
      });
      for (const ordinal of [2, 3]) {
        const runId = ordinal === 2 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 2 && status === "interrupted" ? attemptId : null,
                status: ordinal === 2 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 2 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        origin: { kind: "user" as const },
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "GRANDPARENT_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "SOURCE_ROLLED_BACK_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "ROLLED_BACK_MARKER");
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { execution: "portable_context", rejected: true },
  { execution: "native_fork", rejected: false },
] as const)(
  "a $execution fork's first /compact is rejected only when no history reaches it: $rejected",
  ({ execution, rejected }) => {
    const opened: Array<ProviderInstanceId> = [];
    const adapter = (driverName: "claudeAgent" | "codex") => {
      const driver = ProviderDriverKind.make(driverName);
      const instanceId = ProviderInstanceId.make(driverName);
      return {
        instanceId,
        driver,
        getCapabilities: () =>
          Effect.succeed(
            driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
          ),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.sync(() => opened.push(instanceId)).pipe(
            Effect.andThen(
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
              }),
            ),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
    };
    const claude = adapter("claudeAgent");
    const target = execution === "portable_context" ? adapter("codex") : claude;
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-compact-source");
      const targetThreadId = ThreadId.make("fork-compact-target");
      const providerThreadId = ProviderThreadId.make("fork-compact-native-thread");
      const sourceRunId = RunId.make("fork-compact-source-run");
      const userMessageId = MessageId.make("fork-compact-source-message");
      const sourceSelection = { instanceId: claude.instanceId, model: "test-model" };

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("fork-compact-create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-compact-project"),
        title: "Fork compact source",
        modelSelection: sourceSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const item = {
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("fork-compact-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: claude.driver,
              providerInstanceId: claude.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: claude.driver,
                nativeId: "native-fork-compact-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("fork-compact-source-run"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: claude.instanceId,
              modelSelection: sourceSelection,
              providerThreadId,
              userMessageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          // Each message alone exceeds the default 16k handoff budget, so a
          // portable handoff omits both whole items.
          {
            id: EventId.make("fork-compact-user-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-user-item"),
              ordinal: 1,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId: userMessageId,
              text: "u".repeat(17_000),
              attachments: [],
            },
          },
          {
            id: EventId.make("fork-compact-assistant-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-assistant-item"),
              ordinal: 2,
              type: "assistant_message",
              messageId: MessageId.make("fork-compact-assistant-message"),
              text: "a".repeat(17_000),
              streaming: false,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-compact-fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        origin: { kind: "user" as const },
        commandId: CommandId.make("fork-compact-compact"),
        threadId: targetThreadId,
        messageId: MessageId.make("fork-compact-compact"),
        text: "/compact",
        attachments: [],
        modelSelection: { instanceId: target.instanceId, model: "test-model" },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();

      const projection = yield* orchestrator.getThreadProjection(targetThreadId);
      if (execution === "portable_context") {
        assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "portable_context");
        assert.deepEqual(projection.contextHandoffs[0]?.history?.messages, []);
      } else {
        assert.isEmpty(projection.contextHandoffs);
      }
      const emptyCompaction = projection.turnItems.some(
        (turnItem) =>
          turnItem.type === "error" &&
          turnItem.failure.message === "Start a conversation before compacting this thread.",
      );
      assert.equal(emptyCompaction, rejected);
      assert.deepEqual(opened, rejected ? [] : [target.instanceId]);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `fork-compact-${execution}` },
          ProviderAdapterRegistry.layerFromAdapters(
            target === claude ? [claude] : [claude, target],
          ),
        ),
      ),
    );
  },
);

const writeParentRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  /** Preparing, failed, and interrupted runs asked for a new worktree. */
  readonly status:
    | "preparing"
    | "running"
    | "queued"
    | "completed"
    | "rolled_back"
    | "failed"
    | "interrupted";
  readonly text: string;
  readonly transcript?: { readonly streaming?: boolean };
  /** A checkpointed run on a native provider thread, which `latest_stable` forks start from. */
  readonly stable?: boolean;
  readonly nativeBoundary?: boolean;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { driver, instanceId, modelSelection } = forkCases[0]!;
    const messageId = MessageId.make(`${input.runId}:message`);
    const nodeId = input.transcript === undefined ? null : NodeId.make(`${input.runId}:root`);
    const providerThreadId = input.stable
      ? ProviderThreadId.make(`${input.runId}:provider-thread`)
      : null;
    const attemptId = input.nativeBoundary ? RunAttemptId.make(`${input.runId}:attempt`) : null;
    yield* eventSink.write({
      events: [
        ...(providerThreadId === null
          ? []
          : [
              {
                id: EventId.make(`${input.runId}:provider-thread`),
                type: "provider-thread.updated" as const,
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: null,
                  appThreadId: input.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: `${input.runId}:native`,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: null,
                  status: "idle" as const,
                  firstRunOrdinal: input.ordinal,
                  lastRunOrdinal: input.ordinal,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: messageId,
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status: input.status,
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt:
              input.status === "preparing" ||
              input.status === "running" ||
              input.status === "queued"
                ? null
                : now,
            checkpointId: input.stable ? CheckpointId.make(`${input.runId}:checkpoint`) : null,
            contextHandoffId: null,
            ...(input.status === "preparing" ||
            input.status === "failed" ||
            input.status === "interrupted"
              ? { workspacePreparation: { type: "worktree" as const, baseRef: "main" } }
              : {}),
          },
        },
        ...(attemptId === null || providerThreadId === null
          ? []
          : [
              {
                id: EventId.make(`${input.runId}:provider-turn`),
                type: "provider-turn.updated" as const,
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`${input.runId}:provider-turn`),
                  providerThreadId,
                  nodeId: NodeId.make(`${input.runId}:root`),
                  runAttemptId: attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `${input.runId}:turn`,
                    strength: "strong" as const,
                  },
                  ordinal: input.ordinal,
                  status: "completed" as const,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ]),
        ...(input.transcript === undefined
          ? []
          : [
              {
                id: EventId.make(`${input.runId}:conversation`),
                type: "message.updated" as const,
                threadId: input.threadId,
                runId: input.runId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId: input.threadId,
                  runId: input.runId,
                  nodeId,
                  role: "assistant" as const,
                  text: input.text,
                  attachments: [],
                  streaming: input.transcript.streaming ?? false,
                  createdAt: now,
                  updatedAt: now,
                  createdBy: "agent" as const,
                  creationSource: "provider" as const,
                },
              },
            ]),
        {
          id: EventId.make(`${input.runId}:item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${input.runId}:item`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId,
            text: input.text,
            attachments: [],
          },
        },
      ],
    });
  });

/** Marks `threadId` as imported from V1 and gives it one runless imported user message. */
const writeImportedHistory = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${threadId}:imported`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, historyOrigin: "v1_import" },
        },
        {
          id: EventId.make(`${threadId}:imported-item`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${threadId}:imported-item`),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId: MessageId.make(`${threadId}:imported-message`),
            text,
            attachments: [],
          },
        },
      ],
    });
  });

const createParent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("side-chat-project"),
      title: "Side chat parent",
      modelSelection: forkCases[0]!.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const forkSideChat = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(commandId),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "latest_stable" },
      sideChat: true,
      createdBy: "user",
      creationSource: "web",
    });
  });

const askSideChat = (
  threadId: ThreadId,
  commandId: string,
  modelSelection?: (typeof forkCases)[number]["modelSelection"],
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      origin: { kind: "user" as const },
      commandId: CommandId.make(commandId),
      threadId,
      messageId: MessageId.make(commandId),
      text: "What is the main thread doing?",
      attachments: [],
      ...(modelSelection === undefined ? {} : { modelSelection }),
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("resolves an explicit checkpoint fork to its source run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const parentId = ThreadId.make("checkpoint-fork-parent");
    const childId = ThreadId.make("checkpoint-fork-child");
    const runId = RunId.make("checkpoint-fork-run");
    const checkpointId = CheckpointId.make("checkpoint-fork-checkpoint");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId,
      ordinal: 1,
      status: "completed",
      text: "Work",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("checkpoint-fork-captured"),
          type: "checkpoint.captured",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId: parentId,
            scopeId: CheckpointScopeId.make("checkpoint-fork-scope"),
            runId,
            nodeId: NodeId.make("checkpoint-fork-node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: CheckpointRef.make("refs/t3/checkpoint-fork/1"),
            status: "ready",
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("checkpoint-fork"),
      sourceThreadId: parentId,
      targetThreadId: childId,
      sourcePoint: { type: "checkpoint", checkpointId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const child = yield* orchestrator.getThreadShell(childId);
    assert.deepEqual(child?.forkedFrom, { type: "run", threadId: parentId, runId });
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat of a busy parent points history recovery at the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-recovery-parent");
    const sideChatId = ThreadId.make("side-chat-recovery-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-recovery-stable-run"),
      ordinal: 1,
      status: "completed",
      text: "Earlier parent history",
      stable: true,
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-recovery-busy-run"),
      ordinal: 2,
      status: "running",
      text: "Parent work in progress",
    });
    yield* forkSideChat("side-chat-recovery-fork", parentId, sideChatId);
    yield* askSideChat(sideChatId, "side-chat-recovery-first-message");

    const started = yield* orchestrator.getThreadProjection(sideChatId);
    assert.equal(started.contextTransfers[0]?.resolution?.strategy, "portable_context");
    const handoff = started.contextHandoffs.find((item) => item.strategy === "full_thread_summary");
    const coverage = handoff?.history?.coverage ?? "";
    assert.include(coverage, `t3_thread_read({threadId:"${parentId}"`);
    assert.notInclude(coverage, `threadId:"${sideChatId}"`);
    assert.isFalse(started.turnItems.some((item) => item.type === "handoff"));
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each([false, true])(
  "keeps a bounded native Codex fork while the parent is busy (side chat %s)",
  (sideChat) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parentId = ThreadId.make("native-busy-parent");
      const childId = ThreadId.make("native-busy-child");
      const stableRunId = RunId.make("native-busy-stable");
      yield* createParent(parentId);
      yield* writeParentRun({
        threadId: parentId,
        runId: stableRunId,
        ordinal: 1,
        status: "completed",
        text: "Keep this history",
        stable: true,
        nativeBoundary: true,
      });
      yield* writeParentRun({
        threadId: parentId,
        runId: RunId.make("native-busy-current"),
        ordinal: 2,
        status: "running",
        text: "Parent is still working",
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("native-busy-fork"),
        sourceThreadId: parentId,
        targetThreadId: childId,
        sourcePoint: sideChat ? { type: "latest_stable" } : { type: "run", runId: stableRunId },
        sideChat,
        createdBy: "user",
        creationSource: "web",
      });
      yield* askSideChat(childId, "native-busy-first-message");
      const started = yield* orchestrator.getThreadProjection(childId);
      assert.equal(
        started.providerThreads[0]?.forkedFrom?.providerTurnId,
        ProviderTurnId.make(`${stableRunId}:provider-turn`),
      );
      assert.isFalse(
        started.contextHandoffs.some((item) => item.strategy === "full_thread_summary"),
      );
    }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat of an idle parent still starts with the framing note", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-idle-parent");
    const sideChatId = ThreadId.make("side-chat-idle-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-idle-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });

    const reads: Array<string> = [];
    const recordReads: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (/^\s*SELECT/i.test(query)) reads.push(query);
      return Effect.succeed(statement);
    };
    yield* forkSideChat("side-chat-idle-fork", parentId, sideChatId).pipe(
      Effect.provideService(Statement.CurrentTransformer, recordReads),
    );
    assert.isEmpty(
      reads.filter(
        (query) =>
          query.includes("FROM orchestration_v2_projection_checkpoints") ||
          query.includes("FROM orchestration_v2_projection_context_transfers"),
      ),
    );
    assert.equal(
      (yield* orchestrator.getThreadProjection(sideChatId)).thread.runtimeMode,
      "full-access",
    );
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("side-chat-parent-mode-change"),
      threadId: parentId,
      runtimeMode: "approval-required",
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(sideChatId)).thread.runtimeMode,
      "full-access",
    );
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("side-chat-child-mode-change"),
      threadId: sideChatId,
      runtimeMode: "auto",
    });
    yield* askSideChat(sideChatId, "side-chat-idle-first-message", {
      ...forkCases[0]!.modelSelection,
      model: "side-chat-model",
    });

    const started = yield* orchestrator.getThreadProjection(sideChatId);
    assert.equal(started.thread.runtimeMode, "auto");
    assert.equal(
      (yield* orchestrator.getThreadProjection(parentId)).thread.runtimeMode,
      "approval-required",
    );
    assert.isNotNull(started.providerThreads[0]?.forkedFrom);
    // The side chat does not show the parent's run, so it is no baseline.
    assert.isFalse(
      started.turnItems.some((item) => item.type === "user_message" && item.modelSwitch),
    );
    assert.lengthOf(started.contextHandoffs, 1);
    const [handoff] = started.contextHandoffs;
    assert.isTrue(
      handoff!.summaryText.startsWith("You are in a side chat beside the main thread."),
    );
    assert.notInclude(handoff!.summaryText, "Main thread activity");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect(
  "snapshots only eligible side-chat messages on explicit send and replays its receipt",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = ThreadId.make("refresh-parent");
      const child = ThreadId.make("refresh-child");
      const sibling = ThreadId.make("refresh-sibling");
      const regularFork = ThreadId.make("refresh-normal-fork");
      const other = ThreadId.make("refresh-same-project");
      const inheritedRun = RunId.make("refresh-parent-1");
      const write = (threadId: ThreadId, ordinal: number, text: string, streaming = false) =>
        writeParentRun({
          threadId,
          runId: RunId.make(`${threadId}-${ordinal}`),
          ordinal,
          status: "completed",
          stable: threadId === parent && ordinal === 1,
          text,
          transcript: { streaming },
        });
      yield* createParent(parent);
      yield* createParent(other);
      yield* write(parent, 1, "Already inherited");
      yield* forkSideChat("refresh-child-fork", parent, child);
      yield* forkSideChat("refresh-sibling-fork", parent, sibling);
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("refresh-normal-fork"),
        sourceThreadId: parent,
        targetThreadId: regularFork,
        sourcePoint: { type: "run", runId: inheritedRun },
        createdBy: "user",
        creationSource: "web",
      });
      yield* write(parent, 2, "Parent update at submit");
      yield* write(sibling, 1, "Sibling update at submit");
      yield* write(sibling, 2, "Streaming draft", true);
      yield* write(regularFork, 1, "Normal fork text");
      yield* write(other, 1, "Unrelated project chat");
      const destination = ProjectId.make("refresh-moved-project");
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const projectCommandId = CommandId.make("refresh-create-project");
      yield* eventSink.commitProjectCommand({
        projectId: destination,
        commandId: projectCommandId,
        commandType: "project.create",
        acceptedAt: now,
        event: {
          eventId: EventId.make("refresh-moved-project"),
          aggregateKind: "project",
          aggregateId: destination,
          occurredAt: createdAt,
          commandId: projectCommandId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: destination,
            title: "Destination",
            workspaceRoot: "/destination",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.workspace.select",
        commandId: CommandId.make("refresh-move-parent"),
        threadId: parent,
        expected: { worktreePath: null, xwingEnvironmentId: null },
        projectId: destination,
        worktreePath: "/destination",
        branch: null,
        developmentEnvironment: null,
      });
      yield* askSideChat(child, "refresh-unarmed");

      const command = {
        type: "message.dispatch",
        origin: { kind: "user" },
        commandId: CommandId.make("refresh-armed"),
        threadId: child,
        messageId: MessageId.make("refresh-armed"),
        text: "My own prompt",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
        refreshSideChatContext: true,
      } as const;
      const accepted = yield* orchestrator.dispatch(command);
      const first = yield* orchestrator.getThreadProjection(child);
      assert.equal(
        first.runs.find((run) => run.userMessageId === command.messageId)?.status,
        "queued",
      );
      assert.isUndefined(
        first.messages.find((message) => message.id === MessageId.make("refresh-unarmed"))?.context
          ?.sideChatRefresh,
      );
      const saved = first.messages.find((message) => message.id === command.messageId);
      assert.equal(saved?.text, "My own prompt");
      const snapshot = saved?.context?.sideChatRefresh ?? "";
      assert.include(snapshot, "Parent update at submit");
      assert.include(snapshot, "Sibling update at submit");
      for (const excluded of [
        "Already inherited",
        "Streaming draft",
        "Normal fork text",
        "Unrelated project chat",
      ]) {
        assert.notInclude(snapshot, excluded);
      }

      yield* write(sibling, 3, "Later sibling update");
      const replay = yield* orchestrator.dispatch(command);
      assert.isTrue(replay.replayed);
      assert.equal(replay.sequence, accepted.sequence);
      const afterReplay = yield* orchestrator.getThreadProjection(child);
      assert.deepEqual(
        afterReplay.messages.filter((message) => message.id === command.messageId),
        [saved],
      );

      const queuedRun = afterReplay.runs.find((run) => run.userMessageId === command.messageId)!;
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        threadId: child,
        runId: queuedRun.id,
        commandId: CommandId.make("refresh-edit"),
        text: "Edited prompt",
        context: { version: 1, records: [] },
      });
      const edited = (yield* orchestrator.getThreadProjection(child)).messages.find(
        (message) => message.id === command.messageId,
      );
      assert.equal(edited?.text, "Edited prompt");
      assert.equal(edited?.context?.sideChatRefresh, snapshot);

      const nextMessageId = MessageId.make("refresh-later");
      yield* orchestrator.dispatch({
        ...command,
        commandId: CommandId.make("refresh-later"),
        messageId: nextMessageId,
      });
      const afterNext = yield* orchestrator.getThreadProjection(child);
      assert.include(
        afterNext.messages.find((message) => message.id === nextMessageId)?.context
          ?.sideChatRefresh ?? "",
        "Later sibling update",
      );

      yield* TestClock.adjust("1 millis");
      const rootMessageId = MessageId.make("refresh-root");
      yield* orchestrator.dispatch({
        ...command,
        threadId: parent,
        commandId: CommandId.make("refresh-root"),
        messageId: rootMessageId,
      });
      const root = yield* orchestrator.getThreadProjection(parent);
      const rootSnapshot =
        root.messages.find((message) => message.id === rootMessageId)?.context?.sideChatRefresh ??
        "";
      assert.include(rootSnapshot, "Later sibling update");
      assert.notInclude(rootSnapshot, "Parent update at submit");
    }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat waits for the parent's new worktree, also after its setup ended", () =>
  Effect.gen(function* () {
    for (const status of ["preparing", "failed", "interrupted"] as const) {
      const parentId = ThreadId.make(`side-chat-worktree-parent-${status}`);
      yield* createParent(parentId);
      yield* writeParentRun({
        threadId: parentId,
        runId: RunId.make(`side-chat-worktree-parent-run-${status}`),
        ordinal: 1,
        status,
        text: "Parent work",
      });

      const rejected = yield* forkSideChat(
        `side-chat-worktree-fork-${status}`,
        parentId,
        ThreadId.make(`side-chat-worktree-child-${status}`),
      ).pipe(Effect.flip);
      assert.include(String(rejected.cause), "has no worktree yet", status);
    }
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat opens once a later run has worked in the project checkout", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-worktree-abandoned-parent");
    const sideChatId = ThreadId.make("side-chat-worktree-abandoned-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-worktree-abandoned-run-1"),
      ordinal: 1,
      status: "interrupted",
      text: "Stopped during setup",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-worktree-abandoned-run-2"),
      ordinal: 2,
      status: "completed",
      text: "Worked in the project checkout",
      stable: true,
    });

    yield* forkSideChat("side-chat-worktree-abandoned-fork", parentId, sideChatId);
    assert.isNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);

    // A retried setup that is running again, or failed again, comes after the later run.
    for (const status of ["preparing", "failed"] as const) {
      const retriedParentId = ThreadId.make(`side-chat-worktree-retried-parent-${status}`);
      yield* createParent(retriedParentId);
      yield* writeParentRun({
        threadId: retriedParentId,
        runId: RunId.make(`side-chat-worktree-retried-run-2-${status}`),
        ordinal: 2,
        status: "completed",
        text: "Worked in the project checkout",
        stable: true,
      });
      yield* TestClock.adjust("1 second");
      yield* writeParentRun({
        threadId: retriedParentId,
        runId: RunId.make(`side-chat-worktree-retried-run-1-${status}`),
        ordinal: 1,
        status,
        text: "Retried setup",
      });
      const rejected = yield* forkSideChat(
        `side-chat-worktree-retried-fork-${status}`,
        retriedParentId,
        ThreadId.make(`side-chat-worktree-retried-child-${status}`),
      ).pipe(Effect.flip);
      assert.include(String(rejected.cause), "has no worktree yet", status);
    }
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("persists nested side-chat selections at the selected reply's stable run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const root = ThreadId.make("selection-root");
    const child = ThreadId.make("selection-child");
    const grandchild = ThreadId.make("selection-grandchild");
    yield* createParent(root);
    const seedReply = (threadId: ThreadId, ordinal: number, stable = true) =>
      Effect.gen(function* () {
        const runId = RunId.make(`${threadId}:run:${ordinal}`);
        yield* writeParentRun({
          threadId,
          runId,
          ordinal,
          status: stable ? "completed" : "running",
          stable,
          text: "Question",
        });
        const messageId = MessageId.make(`${runId}:reply`);
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              type: "message.updated",
              id: EventId.make(`${messageId}:updated`),
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId,
                runId,
                role: "assistant",
                text: "**Selected text**",
                nodeId: null,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                createdBy: "agent",
                creationSource: "provider",
              },
            },
          ],
        });
        return { runId, messageId };
      });
    const reply = yield* seedReply(root, 1);
    yield* seedReply(root, 2);
    const running = yield* seedReply(root, 3, false);
    const anchorFor = (messageId: MessageId) => ({
      messageId,
      text: "Selected",
      start: 0,
      end: 8,
      prefix: "",
      suffix: " text",
    });
    const fork = (sourceThreadId: ThreadId, targetThreadId: ThreadId, messageId: MessageId) =>
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`${targetThreadId}:fork:${messageId}`),
        sourceThreadId,
        targetThreadId,
        sideChat: true,
        sourcePoint: { type: "assistant_selection", anchor: anchorFor(messageId) },
        createdBy: "user",
        creationSource: "web",
      });
    const assertFork = (threadId: ThreadId, parentId: ThreadId, source: typeof reply) =>
      Effect.gen(function* () {
        const { thread, contextTransfers } = yield* orchestrator.getThreadProjection(threadId);
        assert.deepInclude(thread.lineage, {
          sideChat: true,
          parentThreadId: parentId,
          rootThreadId: root,
          sideChatAnchor: anchorFor(source.messageId),
        });
        assert.deepInclude(
          contextTransfers.find((transfer) => transfer.targetThreadId === threadId)?.sourcePoint,
          {
            threadId: parentId,
            runId: source.runId,
          },
        );
      });

    const unstable = yield* fork(root, child, running.messageId).pipe(Effect.flip);
    assert.include(String(unstable.cause), "stable");
    yield* fork(root, child, reply.messageId);
    yield* assertFork(child, root, reply);
    assert.deepEqual(
      (yield* orchestrator.getThreadShell(child))?.lineage.sideChatAnchor,
      anchorFor(reply.messageId),
    );
    const unrelated = yield* fork(child, grandchild, reply.messageId).pipe(Effect.flip);
    assert.include(String(unrelated.cause), "assistant reply");
    const userMessageId = MessageId.make(`${reply.runId}:message`);
    const userMessage = yield* fork(root, grandchild, userMessageId).pipe(Effect.flip);
    assert.include(String(userMessage.cause), "assistant reply");
    yield* askSideChat(child, "selection-child-first-message");
    const childProjection = yield* orchestrator.getThreadProjection(child);
    assert.include(
      childProjection.contextHandoffs.find((handoff) => handoff.strategy === "manual_context")
        ?.summaryText,
      JSON.stringify(anchorFor(reply.messageId).text),
    );
    const nestedReply = yield* seedReply(child, 2);
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const forkReady = yield* Deferred.make<void>();
    const releaseFork = yield* Deferred.make<void>();
    const deletionQueued = yield* Deferred.make<void>();
    const commitCommand = sink.commitCommand;
    const { withDeletionLock, withLock } = executor;
    const commitSpy = vi
      .spyOn(sink, "commitCommand")
      .mockImplementation((input) =>
        input.threadId === grandchild
          ? Deferred.succeed(forkReady, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFork)),
              Effect.andThen(commitCommand(input)),
            )
          : commitCommand(input),
      );
    const observeDeletion: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withDeletionLock"] =
      (effect) =>
        Deferred.isDone(forkReady).pipe(
          Effect.flatMap((ready) =>
            ready ? Deferred.succeed(deletionQueued, undefined) : Effect.void,
          ),
          Effect.andThen(withDeletionLock(effect)),
        );
    const deletionSpy = vi.spyOn(executor, "withDeletionLock").mockImplementation(observeDeletion);
    const lockRequests: ThreadId[] = [];
    const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
      threadId,
      effect,
    ) =>
      Effect.suspend(() => {
        lockRequests.push(threadId);
        return withLock(threadId, effect);
      });
    const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
    yield* Effect.gen(function* () {
      const creating = yield* fork(child, grandchild, nestedReply.messageId).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.raceFirst(
        Deferred.await(forkReady),
        Fiber.join(creating).pipe(Effect.andThen(Effect.die("Fork skipped its commit barrier."))),
      );
      assert.deepEqual(lockRequests, [child, grandchild]);
      const deleting = yield* orchestrator
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make("selection-delete-root"),
          threadId: root,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.raceFirst(
        Deferred.await(deletionQueued),
        Fiber.join(deleting).pipe(
          Effect.andThen(Effect.die("Delete bypassed the in-flight fork.")),
        ),
      );
      yield* Deferred.succeed(releaseFork, undefined);
      yield* Fiber.join(creating);
      yield* Fiber.join(deleting);
      assert.deepEqual(lockRequests.slice(0, 5), [child, grandchild, root, child, grandchild]);
      yield* assertFork(grandchild, child, nestedReply);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lockSpy.mockRestore();
          deletionSpy.mockRestore();
          commitSpy.mockRestore();
        }),
      ),
    );
    assert.isNotNull((yield* orchestrator.getThreadProjection(child)).thread.deletedAt);
    assert.isNotNull((yield* orchestrator.getThreadProjection(grandchild)).thread.deletedAt);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("closing a side chat deletes it only while unused; a deleted parent takes no more", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-close-parent");
    const unused = ThreadId.make("side-chat-close-unused");
    const used = ThreadId.make("side-chat-close-used");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-close-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });
    yield* forkSideChat("side-chat-close-fork-unused", parentId, unused);
    yield* forkSideChat("side-chat-close-fork-used", parentId, used);
    yield* askSideChat(used, "side-chat-close-used-message");
    const close = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`side-chat-close:${threadId}`),
        threadId,
        onlyIfUnused: true,
      });

    yield* close(unused);
    yield* close(used);
    assert.isNotNull((yield* orchestrator.getThreadProjection(unused)).thread.deletedAt);
    assert.isNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-close-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);
    const orphan = yield* forkSideChat(
      "side-chat-close-orphan",
      parentId,
      ThreadId.make("side-chat-close-orphan"),
    ).pipe(Effect.flip);
    assert.include(String(orphan.cause), "was deleted");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat opened during the parent's first turn starts from a digest", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const grandparentId = ThreadId.make("side-chat-busy-grandparent");
    const grandparentRunId = RunId.make("side-chat-busy-grandparent-run");
    const parentId = ThreadId.make("side-chat-busy-parent");
    const sideChatId = ThreadId.make("side-chat-busy-child");
    yield* createParent(grandparentId);
    yield* writeParentRun({
      threadId: grandparentId,
      runId: grandparentRunId,
      ordinal: 1,
      status: "completed",
      text: "GRANDPARENT_MARKER",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("side-chat-busy-parent-fork"),
      sourceThreadId: grandparentId,
      targetThreadId: parentId,
      sourcePoint: { type: "run", runId: grandparentRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeImportedHistory(parentId, "PARENT_IMPORTED_MARKER");
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-rewound-parent-run"),
      ordinal: 1,
      status: "rolled_back",
      text: "PARENT_ROLLED_BACK_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-busy-parent-run"),
      ordinal: 2,
      status: "running",
      text: "PARENT_RUNNING_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-queued-parent-run"),
      ordinal: 3,
      status: "queued",
      text: "PARENT_QUEUED_MARKER",
    });
    const fork = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(commandId),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

    yield* fork("side-chat-busy-fork", parentId, sideChatId);
    const created = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isTrue(created.thread.lineage.sideChat);
    assert.equal(created.thread.runtimeMode, "full-access");
    assert.isNull(created.thread.forkedFrom);
    assert.deepEqual(created.contextTransfers[0]?.sourcePoint, { threadId: parentId });

    const nested = yield* fork(
      "side-chat-busy-nested",
      sideChatId,
      ThreadId.make("side-chat-busy-nested"),
    ).pipe(Effect.flip);
    assert.equal(nested._tag, "OrchestratorDispatchError");
    const ontoParent = yield* fork("side-chat-busy-onto-parent", sideChatId, parentId).pipe(
      Effect.flip,
    );
    assert.equal(ontoParent._tag, "OrchestratorThreadAlreadyExistsError");
    const ontoExisting = yield* fork("side-chat-busy-onto-existing", parentId, sideChatId).pipe(
      Effect.flip,
    );
    assert.equal(ontoExisting._tag, "OrchestratorThreadAlreadyExistsError");
    const plainOntoExisting = yield* orchestrator
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make("side-chat-busy-plain-onto-existing"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.equal(plainOntoExisting._tag, "OrchestratorThreadAlreadyExistsError");

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      origin: { kind: "user" as const },
      commandId: CommandId.make("side-chat-busy-first-message"),
      threadId: sideChatId,
      messageId: MessageId.make("side-chat-busy-first-message"),
      text: "What is the main thread doing?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const started = yield* orchestrator.getThreadProjection(sideChatId);
    const [handoff] = started.contextHandoffs;
    assert.lengthOf(started.contextHandoffs, 1);
    assert.deepEqual(started.contextTransfers[0]?.resolution, {
      strategy: "portable_context",
      contextHandoffId: handoff!.id,
    });
    assert.include(handoff!.summaryText, "You are in a side chat beside the main thread.");
    // Inherited rows come first, so the cap truncates them first.
    assert.isAbove(
      handoff!.summaryText.indexOf("- User: PARENT_IMPORTED_MARKER"),
      handoff!.summaryText.indexOf("- User: GRANDPARENT_MARKER"),
    );
    assert.include(handoff!.summaryText, "- User: GRANDPARENT_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_ROLLED_BACK_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_QUEUED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_IMPORTED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_RUNNING_MARKER");
    assert.include(handoff!.summaryText, `t3_thread_read on thread ${parentId}`);
    assert.equal(
      started.messages.find((message) => message.role === "user")?.text,
      "What is the main thread doing?",
    );

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-busy-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

const setRunStatus = (
  threadId: ThreadId,
  runId: RunId,
  status: "running" | "completed" | "rolled_back",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${runId}:${status}`),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...run, status, completedAt: status === "running" ? null : now },
        },
      ],
    });
  });

const bringBackHarness = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make(`${name}-parent`);
    const sideChatId = ThreadId.make(`${name}-side`);
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make(`${name}-parent-1`),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });
    yield* forkSideChat(`${name}-fork`, parentId, sideChatId);
    const sideRunId = (ordinal: number) => RunId.make(`${name}-side-${ordinal}`);
    const sideReply = (ordinal: number, text: string) =>
      writeParentRun({
        threadId: sideChatId,
        runId: sideRunId(ordinal),
        ordinal,
        status: "completed",
        text,
        stable: true,
      });
    const bringBack = (commandId: string, through: number, scope?: "additional" | "all") =>
      orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(commandId),
        sourceThreadId: sideChatId,
        targetThreadId: parentId,
        sourcePoint: { type: "run", runId: sideRunId(through) },
        ...(scope === undefined ? {} : { scope }),
        createdBy: "user",
        creationSource: "web",
      });
    const awaitTransfer = (transferId: ContextTransferId, status: "consumed") =>
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        yield* eventSink.stream({ afterSequence: 0, eventType: "context-transfer.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "context-transfer.updated" &&
              stored.event.payload.id === transferId &&
              stored.event.payload.status === status,
          ),
          Stream.runHead,
        );
      });
    const bringBacks = Effect.gen(function* () {
      const parent = yield* orchestrator.getThreadProjection(parentId);
      return parent.contextTransfers
        .filter((transfer) => transfer.type === "merge_back")
        .map((transfer) => ({
          transfer,
          run: parent.runs.find((run) => run.id === transfer.targetRunId),
          message: parent.messages.find(
            (message) =>
              message.id ===
              parent.runs.find((run) => run.id === transfer.targetRunId)?.userMessageId,
          ),
          summary:
            parent.contextHandoffs.find((handoff) => handoff.transferId === transfer.id)
              ?.summaryText ?? "",
        }));
    });
    return { parentId, sideChatId, sideRunId, sideReply, bringBack, awaitTransfer, bringBacks };
  });

it.effect("Bring back queues behind a busy parent and each request carries its own range", () =>
  Effect.gen(function* () {
    const h = yield* bringBackHarness("bring-back-queue");
    const busyRunId = RunId.make("bring-back-queue-parent-2");
    yield* h.sideReply(1, "SIDE_ONE");
    yield* writeParentRun({
      threadId: h.parentId,
      runId: busyRunId,
      ordinal: 2,
      status: "running",
      text: "Parent busy",
      stable: true,
    });

    yield* h.bringBack("bring-back-queue-1", 1);
    // A reply after the click must not enter the queued request.
    yield* h.sideReply(2, "SIDE_TWO");
    yield* h.bringBack("bring-back-queue-2", 2);
    yield* h.bringBack("bring-back-queue-2", 2);

    const queued = yield* h.bringBacks;
    assert.deepEqual(
      queued.map(({ transfer, run, message }) => [
        transfer.status,
        transfer.sourcePoint.runId,
        transfer.mergeBackScope,
        run?.status,
        message?.senderThreadId,
      ]),
      [
        ["pending", h.sideRunId(1), "additional", "queued", h.sideChatId],
        ["pending", h.sideRunId(2), "additional", "queued", h.sideChatId],
      ],
    );

    // Each finished parent turn starts the next queued one.
    yield* setRunStatus(h.parentId, busyRunId, "completed");
    yield* h.awaitTransfer(queued[0]!.transfer.id, "consumed");
    yield* setRunStatus(h.parentId, queued[0]!.run!.id, "completed");
    yield* h.awaitTransfer(queued[1]!.transfer.id, "consumed");
    yield* setRunStatus(h.parentId, queued[1]!.run!.id, "completed");

    const delivered = yield* h.bringBacks;
    assert.deepEqual(
      delivered.map(({ transfer }) => transfer.status),
      ["consumed", "consumed"],
    );
    assert.include(delivered[0]!.summary, "SIDE_ONE");
    assert.notInclude(delivered[0]!.summary, "SIDE_TWO");
    assert.include(delivered[1]!.summary, "SIDE_TWO");
    assert.notInclude(delivered[1]!.summary, "SIDE_ONE");

    const nothingNew = yield* h.bringBack("bring-back-queue-3", 2).pipe(Effect.flip);
    assert.include(String(nothingNew.cause), "Nothing new");

    yield* h.bringBack("bring-back-queue-all", 2, "all");
    const all = (yield* h.bringBacks).at(-1)!;
    assert.equal(all.transfer.mergeBackScope, "all");
    assert.equal(all.transfer.status, "consumed");
    assert.equal(all.run?.status, "starting");
    assert.include(all.summary, "SIDE_ONE");
    assert.include(all.summary, "SIDE_TWO");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a Bring back whose parent turn was cancelled or rolled back is not counted", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const h = yield* bringBackHarness("bring-back-cancel");
    const busyRunId = RunId.make("bring-back-cancel-parent-2");
    yield* h.sideReply(1, "SIDE_ONE");
    yield* writeParentRun({
      threadId: h.parentId,
      runId: busyRunId,
      ordinal: 2,
      status: "running",
      text: "Parent busy",
      stable: true,
    });
    yield* h.bringBack("bring-back-cancel-1", 1);
    const [cancelled] = yield* h.bringBacks;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("bring-back-cancel-run"),
      threadId: h.parentId,
      runId: cancelled!.run!.id,
    });
    const [failed] = yield* h.bringBacks;
    assert.equal(failed!.transfer.status, "failed");
    assert.include(failed!.transfer.error ?? "", "cancelled");

    yield* setRunStatus(h.parentId, busyRunId, "completed");
    yield* h.bringBack("bring-back-cancel-2", 1);
    const retried = (yield* h.bringBacks).at(-1)!;
    assert.equal(retried.transfer.status, "consumed");
    assert.include(retried.summary, "SIDE_ONE");

    // Rolling back the parent turn removes the context it delivered.
    yield* setRunStatus(h.parentId, retried.run!.id, "rolled_back");
    yield* h.bringBack("bring-back-cancel-3", 1);
    const afterRollback = (yield* h.bringBacks).at(-1)!;
    assert.include(afterRollback.summary, "SIDE_ONE");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("Bring back from sibling side chats queues each behind the parent's work", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("merge-back-guard-parent");
    const parentRunId = RunId.make("merge-back-guard-parent-run");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: parentRunId,
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });
    const forkAndRun = (name: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`merge-back-guard-${name}`);
        const runId = RunId.make(`merge-back-guard-${name}-run`);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`merge-back-guard-fork-${name}`),
          sourceThreadId: parentId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId: parentRunId },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* writeParentRun({
          threadId,
          runId,
          ordinal: 1,
          status: "completed",
          text: name,
          stable: true,
        });
        return { threadId, runId };
      });
    const mergeBack = (commandId: string, fork: { threadId: ThreadId; runId: RunId }) =>
      orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(commandId),
        sourceThreadId: fork.threadId,
        targetThreadId: parentId,
        sourcePoint: { type: "run", runId: fork.runId },
        createdBy: "user",
        creationSource: "web",
      });
    const first = yield* forkAndRun("first");
    const second = yield* forkAndRun("second");

    yield* mergeBack("merge-back-guard-first", first);
    yield* mergeBack("merge-back-guard-second", second);

    const parent = yield* orchestrator.getThreadProjection(parentId);
    assert.deepEqual(
      parent.contextTransfers
        .filter((transfer) => transfer.type === "merge_back")
        .map((transfer) => [
          transfer.sourceThreadId,
          transfer.status,
          parent.runs.find((run) => run.id === transfer.targetRunId)?.status,
        ]),
      [
        [first.threadId, "consumed", "starting"],
        [second.threadId, "pending", "queued"],
      ],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

const runForkWithFailingNativeSource = (forkFailures: number) => {
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const modelSelection = { instanceId, model: "test-model" };
  const started = Deferred.makeUnsafe<ProviderAdapter.ProviderAdapterV2TurnInput>();
  let forkCalls = 0;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/tmp/fork-missing-native-source",
            model: modelSelection.model,
            capabilities: ClaudeProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              nativeThreadRef: { driver, nativeId: "native-fresh-fork", strength: "strong" },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) => Deferred.succeed(started, turn).pipe(Effect.asVoid),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: ({ sourceProviderThread, targetThreadId }) =>
            ++forkCalls <= forkFailures
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver,
                    providerThreadId: sourceProviderThread.id,
                    cause:
                      "Session not found: native-deleted-source; authorization=BearerSyntheticSecret",
                  }),
                )
              : Effect.succeed({
                  ...sourceProviderThread,
                  appThreadId: targetThreadId,
                  nativeThreadRef: { driver, nativeId: "native-forked", strength: "strong" },
                  updatedAt: now,
                }),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const now = yield* DateTime.now;
    const sourceThreadId = ThreadId.make("fork-missing-source");
    const targetThreadId = ThreadId.make("fork-missing-target");
    const providerThreadId = ProviderThreadId.make("fork-missing-native-thread");
    const sourceRunId = RunId.make("fork-missing-source-run");
    const userMessageId = MessageId.make("fork-missing-source-message");

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-missing-create-source"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-missing-project"),
      title: "Fork missing source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-missing-provider-thread"),
          type: "provider-thread.updated",
          threadId: sourceThreadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: sourceThreadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "native-deleted-source", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("fork-missing-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("fork-missing-user-item"),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("fork-missing-user-item"),
            threadId: sourceThreadId,
            runId: sourceRunId,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId: userMessageId,
            text: "FORKED_SOURCE_MARKER",
            attachments: [],
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-missing-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      origin: { kind: "user" as const },
      commandId: CommandId.make("fork-missing-continue"),
      threadId: targetThreadId,
      messageId: MessageId.make("fork-missing-continue"),
      text: "Continue the fork",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    // Run every start attempt so the last one runs with willRetry false.
    for (let attempt = 0; attempt < 5; attempt++) {
      yield* worker.drain();
      yield* TestClock.adjust("1 second");
    }

    const projection = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.deepEqual(
      projection.turnItems.flatMap((item) => (item.type === "error" ? [item.title] : [])),
      [],
    );
    assert.equal(projection.runs[0]?.status, "running");
    return { projection, turn: yield* Deferred.await(started), forkCalls };
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "fork-missing-native-source" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
      ),
    ),
  );
};

it.effect("a native fork whose source session is gone starts fresh with the source history", () =>
  Effect.gen(function* () {
    const { projection, turn } = yield* runForkWithFailingNativeSource(Number.POSITIVE_INFINITY);
    // Resolving the fork transfer stops later sends from retrying the native fork.
    assert.equal(projection.contextTransfers[0]?.status, "resolved_portable");
    assert.isNull(projection.providerThreads[0]?.forkedFrom);
    assert.include(JSON.stringify(turn), "FORKED_SOURCE_MARKER");
    const notices = projection.turnItems.flatMap((item) =>
      item.type === "system_notice" ? [item.message] : [],
    );
    assert.lengthOf(notices, 1);
    assert.include(notices[0], "Session not found: native-deleted-source");
    assert.notInclude(notices[0], "BearerSyntheticSecret");
  }),
);

it.effect("a native fork that fails before its last attempt still forks natively", () =>
  Effect.gen(function* () {
    const { projection, forkCalls } = yield* runForkWithFailingNativeSource(1);
    assert.equal(forkCalls, 2);
    assert.equal(projection.contextTransfers[0]?.status, "consumed");
    assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "native_fork");
  }),
);
