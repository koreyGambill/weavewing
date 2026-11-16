import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

// A delegated task whose child runs in a linked environment is recorded on
// its parent without a child thread here, and completing it wakes the parent
// the way a local child's result does.

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for delegated task records"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** Every parent wake the orchestrator offers, for the tests to read. */
class Offers extends Context.Service<
  Offers,
  Queue.Queue<ProviderContinuationRequests.ProviderContinuationRequest>
>()("t3/orchestration-v2/RemoteDelegatedTask.test/Offers") {}
const layerOffers = Layer.effect(
  Offers,
  Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>(),
);
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "remote-delegated-task" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provide(
    Layer.effect(
      ProviderContinuationRequests.ProviderContinuationRequests,
      Offers.pipe(
        Effect.map((offers) => ({
          offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
            Queue.offer(offers, request).pipe(Effect.asVoid),
          take: Effect.never,
        })),
      ),
    ),
  ),
  Layer.provideMerge(layerOffers),
);

/** A parent thread whose run is live, as when its agent calls delegate_task. */
const seedLiveParent = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${name}`);
    const runId = RunId.make(`run:${name}`);
    const rootNodeId = NodeId.make(`node:${name}:root`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${name}`),
      threadId,
      projectId: ProjectId.make("project:remote-delegated-task"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* sink.write({
      commandId: CommandId.make(`command:seed:${name}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${name}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`event:seed-node:${name}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`event:seed-run:${name}`),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${name}`),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    return { threadId, runId, rootNodeId };
  });

const remoteChild = {
  environmentId: EnvironmentId.make("environment:box"),
  threadId: ThreadId.make("thread:on-the-box"),
  label: "Box",
};

it.layer(layerTest)("a delegated task in a linked environment", (it) => {
  const sealedGroupCases = (["completed", "interrupted", "failed", "cancelled"] as const).flatMap(
    (status) =>
      (
        [
          ["always", "always"],
          ["settled_only", "settled_only"],
          ["always", "settled_only"],
          ["settled_only", "always"],
        ] as const
      ).map((policies) => ({ name: `${status}, ${policies.join("/")}`, status, policies })),
  );
  it.effect.each(sealedGroupCases)(
    "holds remote results until the spawning run ends ($name)",
    ({ name, status, policies }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const offers = yield* Offers;
        yield* Queue.clear(offers);
        const parent = yield* seedLiveParent(`sealed-group-${name}`);
        const taskIds: NodeId[] = [];
        for (const [index, completionWake] of policies.entries()) {
          yield* orchestrator.dispatch({
            type: "delegated_task.remote.request",
            commandId: CommandId.make(`command:sealed-group-${name}:${index}`),
            parentThreadId: parent.threadId,
            parentRunId: parent.runId,
            parentNodeId: parent.rootNodeId,
            task: `Task ${index}`,
            driver: ProviderDriverKind.make("remote"),
            modelSelection,
            remoteChild: {
              ...remoteChild,
              threadId: ThreadId.make(`thread:sealed-${name}:${index}`),
            },
            completionWake,
          });
          const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents.find(
            (task) => !taskIds.includes(task.id),
          )!;
          taskIds.push(task.id);
          yield* orchestrator.dispatch({
            type: "delegated_task.remote.complete",
            commandId: CommandId.make(`command:sealed-result-${name}:${index}`),
            parentThreadId: parent.threadId,
            taskId: task.id,
            status: "completed",
            result: `Result ${index}`,
          });
          yield* worker.drain();
          assert.isEmpty(yield* Queue.clear(offers));
          const held = yield* orchestrator.getThreadProjection(parent.threadId);
          assert.sameMembers([...held.runs[0]!.delegatedCompletion!.delivery!.taskIds], taskIds);
        }
        const now = yield* DateTime.now;
        const run = (yield* orchestrator.getThreadProjection(parent.threadId)).runs[0]!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:sealed-parent-ended:${name}`),
              type: "run.updated",
              threadId: parent.threadId,
              runId: parent.runId,
              occurredAt: now,
              payload: { ...run, status, completedAt: now },
            },
          ],
        });
        const offered = yield* Queue.take(offers);
        assert.equal(offered.delegatedCompletion?.parentRunId, parent.runId);
        const delivery = run.delegatedCompletion!.delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          origin: { kind: "system", event: "group complete" },
          commandId: CommandId.make(`command:deliver-sealed:${name}`),
          threadId: parent.threadId,
          messageId: delivery.messageId,
          text: "Group finished",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: parent.runId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
        });
        yield* worker.drain();
        const delivered = yield* orchestrator.getThreadProjection(parent.threadId);
        const wakes = delivered.messages.filter(
          (message) => message.delegatedCompletion !== undefined,
        );
        assert.lengthOf(wakes, 1);
        assert.sameMembers([...wakes[0]!.delegatedCompletion!.taskIds], taskIds);
        assert.include(wakes[0]!.text, "Result 0");
        assert.include(wakes[0]!.text, "Result 1");
        assert.lengthOf(
          delivered.runs.filter((run) => run.userMessageId === delivery.messageId),
          1,
        );
      }),
  );

  it.effect.each(
    (["completed", "failed", "cancelled", "interrupted"] as const).flatMap((status) =>
      (
        [
          ["always", "always"],
          ["settled_only", "settled_only"],
          ["always", "settled_only"],
          ["settled_only", "always"],
        ] as const
      ).flatMap((policies) =>
        [true, false].map((grouped) => ({
          key: `${status}-${policies.join("-")}${grouped ? "-grouped" : ""}`,
          status,
          policies,
          grouped,
        })),
      ),
    ),
  )(
    "delivers both tasks' results in one wake after both finish ($key)",
    ({ key, status, policies, grouped }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const offers = yield* Offers;
        const parent = yield* seedLiveParent(`group-${key}`);
        for (const [index, name] of ["first", "second"].entries()) {
          yield* orchestrator.dispatch({
            type: "delegated_task.remote.request",
            commandId: CommandId.make(`command:group-${key}:${name}`),
            parentThreadId: parent.threadId,
            parentRunId: parent.runId,
            parentNodeId: parent.rootNodeId,
            task: name,
            driver: ProviderDriverKind.make("remote"),
            modelSelection,
            remoteChild: { ...remoteChild, threadId: ThreadId.make(`thread:remote-${name}`) },
            completionWake: policies[index]!,
            ...(grouped ? { completionGroup: "pair" } : {}),
          });
        }
        const projection = yield* orchestrator.getThreadProjection(parent.threadId);
        const tasks = projection.subagents;
        const parentRun = projection.runs[0]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:group-parent-ended:${key}`),
              type: "run.updated",
              threadId: parent.threadId,
              occurredAt: now,
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });
        for (const [index, task] of tasks.entries()) {
          yield* Queue.clear(offers);
          yield* orchestrator.dispatch({
            type: "delegated_task.remote.complete",
            commandId: CommandId.make(`command:group-result-${key}:${task.id}`),
            parentThreadId: parent.threadId,
            taskId: task.id,
            status: index === 0 ? "completed" : status,
            result: `Result ${index}`,
          });
          yield* worker.drain();
          // Ungrouped, the first result is offered at once; the second joins its undispatched wake.
          const held = grouped && index === 0;
          const seen = held ? yield* Queue.clear(offers) : [yield* Queue.take(offers)];
          assert.equal(seen.length, held ? 0 : 1);
        }
        const finished = yield* orchestrator.getThreadProjection(parent.threadId);
        const delivery = finished.runs.find((run) => run.id === parent.runId)!.delegatedCompletion!
          .delivery!;
        assert.sameMembers(
          [...delivery.taskIds],
          tasks.map((task) => task.id),
        );
        const messageId = delivery.messageId;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          origin: { kind: "system", event: "group complete" },
          commandId: CommandId.make(`command:deliver-group:${key}`),
          threadId: parent.threadId,
          messageId,
          text: "Group finished",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: parent.runId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
        });
        yield* worker.drain();
        const delivered = yield* orchestrator.getThreadProjection(parent.threadId);
        const wakes = delivered.messages.filter(
          (message) => message.delegatedCompletion !== undefined,
        );
        assert.equal(wakes.length, 1);
        assert.include(wakes[0]!.text, "Result 0");
        assert.include(wakes[0]!.text, "Result 1");
        assert.equal(delivered.runs.filter((run) => run.userMessageId === messageId).length, 1);
      }),
  );

  it.effect("keeps tasks from different parent runs in separate groups", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const offers = yield* Offers;
      const parent = yield* seedLiveParent("separate-groups");
      const first = yield* orchestrator.getThreadProjection(parent.threadId);
      const firstRun = first.runs[0]!;
      const root = first.nodes[0]!;
      const runIds = [parent.runId, RunId.make("run:separate-groups:2")];
      const now = yield* DateTime.now;
      for (const [index, runId] of runIds.entries()) {
        const rootNodeId = NodeId.make(`node:separate-groups:${index}`);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:separate-root:${index}`),
              type: "node.updated",
              threadId: parent.threadId,
              runId,
              occurredAt: now,
              payload: { ...root, id: rootNodeId, runId, rootNodeId },
            },
            {
              id: EventId.make(`event:separate-run:${index}`),
              type: "run.updated",
              threadId: parent.threadId,
              runId,
              occurredAt: now,
              payload: { ...firstRun, id: runId, ordinal: index + 1, rootNodeId },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.remote.request",
          commandId: CommandId.make(`command:separate-group:${index}`),
          parentThreadId: parent.threadId,
          parentRunId: runId,
          parentNodeId: rootNodeId,
          task: `Task ${index}`,
          driver: ProviderDriverKind.make("remote"),
          modelSelection,
          remoteChild: {
            ...remoteChild,
            threadId: ThreadId.make(`thread:separate-group:${index}`),
          },
          completionWake: "always",
        });
        const projection = yield* orchestrator.getThreadProjection(parent.threadId);
        const run = projection.runs.find((run) => run.id === runId)!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:separate-ended:${index}`),
              type: "run.updated",
              threadId: parent.threadId,
              runId,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
      }
      const tasks = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents;
      const second = tasks.find((task) => task.runId === runIds[1])!;
      yield* Queue.clear(offers);
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.complete",
        commandId: CommandId.make("command:separate-result"),
        parentThreadId: parent.threadId,
        taskId: second.id,
        status: "completed",
        result: "Second group done",
      });
      const seen = [yield* Queue.take(offers)];
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.delegatedCompletion?.parentRunId, runIds[1]);
      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.isUndefined(
        projection.runs.find((run) => run.id === runIds[0])?.delegatedCompletion?.delivery,
      );
      assert.deepEqual(
        projection.runs.find((run) => run.id === runIds[1])?.delegatedCompletion?.delivery?.taskIds,
        [second.id],
      );
    }),
  );

  it.effect("is recorded on its parent without a child thread here, once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* seedLiveParent("records");
      const request = {
        type: "delegated_task.remote.request" as const,
        commandId: CommandId.make("command:remote-delegate:records"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run the suite there.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
        completionWake: "always" as const,
      };
      yield* orchestrator.dispatch(request);
      yield* orchestrator.dispatch(request);
      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.equal(projection.subagents.length, 1);
      const [task] = projection.subagents;
      assert.equal(task?.childThreadId, null);
      assert.deepEqual(task?.remoteChild, remoteChild);
      assert.deepEqual(task?.modelSelection, modelSelection);
      assert.equal(task?.status, "running");
      const item = projection.turnItems.find((candidate) => candidate.type === "subagent");
      assert.deepEqual(item?.type === "subagent" ? item.remoteChild : undefined, remoteChild);
      // No thread was created here for the child.
      assert.equal(yield* orchestrator.getThreadShell(remoteChild.threadId), null);
      const other = yield* seedLiveParent("records-no-task");
      const index = yield* (yield* ProjectionStore.ProjectionStoreV2).listActiveShellIndex();
      assert.isTrue(index.find((entry) => entry.id === parent.threadId)?.hasRemoteTasks);
      assert.isFalse(index.find((entry) => entry.id === other.threadId)?.hasRemoteTasks);
      // Nothing here can cancel the task there, so it must not block archiving.
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:archive:records"),
        threadId: parent.threadId,
      });
      assert.isNotNull((yield* orchestrator.getThreadShell(parent.threadId))?.archivedAt);
    }),
  );

  it.effect("keeps a newer stop recoverable after an older acknowledgement", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* seedLiveParent("stop-generation");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:stop-generation"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run a check.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
      });
      const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      const openFor = projections.getOpenRemoteDelegatedTasks.pipe(
        Effect.map((open) => open.filter((entry) => entry.parentThreadId === parent.threadId)),
      );
      const complete = {
        type: "delegated_task.remote.complete" as const,
        parentThreadId: parent.threadId,
        taskId: task.id,
        status: "completed" as const,
        result: "Original result.",
      };
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:result:stop-generation"),
        stoppedThere: "ran-out",
      });
      for (const count of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "delegated_task.remote.stop",
          parentThreadId: parent.threadId,
          taskId: task.id,
          commandId: CommandId.make(`command:stop-generation:${count}`),
        });
      }
      // Reports from before generation tracking cannot clear a later numbered Stop either.
      for (const stopCount of [undefined, 1]) {
        const rejected = yield* orchestrator
          .dispatch({
            ...complete,
            commandId: CommandId.make(`command:stale-stop:${stopCount}`),
            stoppedThere: "stopped",
            ...(stopCount === undefined ? {} : { stopCount }),
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "OrchestratorDispatchError");
        assert.deepEqual(yield* openFor, [{ parentThreadId: parent.threadId, taskId: task.id }]);
      }
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:current-stop:2"),
        stoppedThere: "stopped",
        stopCount: 2,
      });
      const settled = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      assert.equal(settled.result, "Original result.");
      assert.equal(settled.status, "completed");
      assert.equal(settled.remoteChild?.stoppedThere, true);
      assert.deepEqual(yield* openFor, []);
    }),
  );

  it.effect("owes a stop there for a Stop here that loses the race to its result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* seedLiveParent("stop-after-result");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:stop-after-result"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run a check.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
      });
      const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      const complete = {
        type: "delegated_task.remote.complete" as const,
        parentThreadId: parent.threadId,
        taskId: task.id,
      };
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:result:stop-after-result"),
        status: "completed",
        result: "Done there.",
        stoppedThere: "ran-out",
      });
      // The parent's Stop read the task before its result landed.
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:parent-stop:stop-after-result"),
        status: "interrupted",
        result: "Stopped with its parent.",
      });

      const stopped = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      assert.equal(stopped.status, "completed");
      assert.equal(stopped.result, "Done there.");
      assert.equal(stopped.remoteChild?.stoppedThere, false);
      assert.equal(stopped.remoteChild?.stopCount, 1);
      const open = yield* projections.getOpenRemoteDelegatedTasks;
      assert.deepEqual(
        open.filter((entry) => entry.parentThreadId === parent.threadId),
        [{ parentThreadId: parent.threadId, taskId: task.id }],
      );
    }),
  );

  it.effect("wakes its parent with the result when it completes there", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const parent = yield* seedLiveParent("completes");
      const recorded = yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:completes"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run the suite there.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
        completionWake: "always",
      });
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated" ? taskEvent.event.payload.id : undefined;
      assert.isDefined(taskId);
      // Until it completes, it is open, and a restarted follower picks it up.
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const openFor = projections.getOpenRemoteDelegatedTasks.pipe(
        Effect.map((open) => open.filter((task) => task.parentThreadId === parent.threadId)),
      );
      assert.deepEqual(yield* openFor, [{ parentThreadId: parent.threadId, taskId: taskId! }]);
      const offers = yield* Offers;
      yield* Queue.clear(offers);
      const complete = (result: string) =>
        orchestrator.dispatch({
          type: "delegated_task.remote.complete",
          commandId: CommandId.make(`command:remote-complete:${result}`),
          parentThreadId: parent.threadId,
          taskId: taskId!,
          status: "completed",
          result,
          stoppedThere: "ran-out",
        });
      yield* complete("All 412 tests pass on the box.");
      yield* worker.drain();
      // A second report is refused, so the first result stands.
      const late = yield* complete("A late, different answer.").pipe(Effect.flip);
      assert.equal(late._tag, "OrchestratorDispatchError");

      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      assert.equal(task?.status, "completed");
      assert.equal(task?.result, "All 412 tests pass on the box.");
      assert.equal(task?.completionDelivery?.state, "claimed");
      // Nothing is left for the follower to pick up after a restart.
      assert.deepEqual(yield* openFor, []);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === taskId,
      );
      assert.equal(item?.status, "completed");
      // The spawning run must end before its single result can be delivered.
      const delivery = projection.runs.find((run) => run.id === parent.runId)?.delegatedCompletion
        ?.delivery;
      assert.deepEqual(delivery?.taskIds, [taskId]);
      assert.isEmpty(yield* Queue.clear(offers));
      const sink = yield* EventSink.EventSinkV2;
      const run = projection.runs.find((run) => run.id === parent.runId)!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:single-parent-ended"),
            type: "run.updated",
            threadId: parent.threadId,
            runId: parent.runId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      const offered = yield* Queue.take(offers);
      yield* worker.drain();
      assert.equal(offered.threadId, parent.threadId);
    }),
  );
});
