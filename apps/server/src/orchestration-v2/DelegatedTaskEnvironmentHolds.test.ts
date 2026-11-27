import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  XwingEnvironmentId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
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
  openSession: () => Effect.die("Runs here never reach a provider"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "delegated-task-environment-holds" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const xwingEnvironmentId = XwingEnvironmentId.make("c0ffee0123456789");
const checkout = {
  xwingEnvironmentId,
  repositorySource: "/repo",
  checkoutPath: "/xwing/envs/7/repo",
  number: 7,
  name: "Isolated child",
};

/** A parent with an active run delegates one task, isolated in `checkout` unless `shared`. */
const delegate = (key: string, isolation: "xwing" | "shared") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make(`thread:holds-parent:${key}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${key}`),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:holds"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      origin: { kind: "user" as const },
      commandId: CommandId.make(`lead:${key}`),
      threadId: parentThreadId,
      messageId: MessageId.make(`message:lead:${key}`),
      text: "lead",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${key}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Build it in isolation",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
      ...(isolation === "xwing"
        ? {
            workspaceStrategy: {
              type: "existing_worktree",
              worktreePath: checkout.checkoutPath,
              branch: "t3code/build-it",
            },
            developmentEnvironment: checkout,
          }
        : {}),
    });
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    return { parentThreadId, taskId: task.id, childThreadId: task.childThreadId! };
  });

const finishChildRun = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const run = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:finish:${childThreadId}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    yield* orchestrator.recoverDelegatedTasks;
  });

const releaseEffect = (taskId: string) =>
  EffectOutbox.EffectOutboxV2.pipe(
    Effect.flatMap((outbox) =>
      outbox.get(`effect:development-environment.release-holds:${taskId}`),
    ),
    Effect.map(Option.getOrUndefined),
  );

it.effect("an isolated child works in the Xwing checkout its delegation names", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { childThreadId } = yield* delegate("bound", "xwing");
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const { selectedAt, ...bound } = child.thread.developmentEnvironment!;
    assert.deepEqual(bound, checkout);
    assert.equal(child.thread.worktreePath, checkout.checkoutPath);
    assert.equal(child.thread.branch, "t3code/build-it");
    assert.isTrue(DateTime.isDateTime(selectedAt));
    assert.deepEqual(child.runs[0]?.workspacePreparation, {
      type: "existing_worktree",
      worktreePath: checkout.checkoutPath,
      branch: "t3code/build-it",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["completes", "is cancelled"] as const)(
  "a task whose child has an Xwing environment releases its holds when it %s",
  (ending) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parentThreadId, taskId, childThreadId } = yield* delegate(ending, "xwing");
      assert.isUndefined(yield* releaseEffect(taskId));
      if (ending === "completes") {
        yield* finishChildRun(childThreadId);
      } else {
        yield* orchestrator.cancelDelegatedTask({
          parentThreadId,
          taskId,
          command: {
            type: "thread.stop",
            commandId: CommandId.make(`cancel:${ending}`),
            threadId: childThreadId,
            stopDelegatedTasks: false,
          },
          stopDescendants: () => Effect.void,
        });
      }
      const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (candidate) => candidate.id === taskId,
      );
      assert.equal(task?.status, ending === "completes" ? "completed" : "interrupted");
      const effect = yield* releaseEffect(taskId);
      assert.equal(effect?.threadId, childThreadId);
      assert.deepEqual(effect?.request, {
        type: "development-environment.release-holds",
        xwingEnvironmentId,
      });
      // Settling again finds the task already ended and queues nothing more.
      yield* orchestrator.recoverDelegatedTasks;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      assert.lengthOf(yield* outbox.listByCommandId(effect!.commandId), 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("a task whose child shares the parent's checkout releases no holds", () =>
  Effect.gen(function* () {
    const { taskId, childThreadId } = yield* delegate("shared", "shared");
    yield* finishChildRun(childThreadId);
    assert.isUndefined(yield* releaseEffect(taskId));
  }).pipe(Effect.provide(layer)),
);
