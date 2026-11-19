import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as DateTime from "effect/DateTime";
import {
  EventId,
  MessageId,
  RunId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventTriggers from "./EventTriggers.ts";
import { EVENT_WAKE_BACKSTOP_MS } from "./Schedule.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const input = {
  commandId: "wake-test",
  title: "Resume work",
  prompt: "Continue the authorized work.",
  enabled: true,
  projectId: "project:test",
  threadId: "thread:main",
  threadMode: "continue",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
const decode = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const fixture = Effect.gen(function* () {
  // A PubSub, like the real stream: the idle check-in listener and the event reactor both subscribe.
  const events = yield* PubSub.unbounded<OrchestrationV2StoredEvent>({ replay: 256 });
  const sequence = yield* Ref.make(0);
  const publish = (event: OrchestrationV2DomainEvent) =>
    Ref.updateAndGet(sequence, (n) => n + 1).pipe(
      Effect.flatMap((n) => PubSub.publish(events, { sequence: n, commandId: null, event })),
    );
  const tick = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const sends = yield* Ref.make<ThreadManagementService.ThreadManagementSendInput[]>([]);
  const landed = yield* Ref.make(false);
  const scheduler: Scheduler.Scheduler["Service"] = {
    register: <E, R>(name: string, run: Effect.Effect<void, E, R>) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        if (name === "scheduled-tasks")
          yield* Ref.set(tick, run.pipe(Effect.provideContext(context), Effect.orDie));
      }),
  };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    ManagedPolicy.layerTest(),
    ServerSettings.layerTest(),
    Layer.succeed(Scheduler.Scheduler, scheduler),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      streamDomainEvents: Stream.fromPubSub(events).pipe(Stream.map((stored) => stored.event)),
      streamDomainEventsFrom: ({ eventType, afterSequence }) =>
        Stream.fromPubSub(events).pipe(
          Stream.filter(
            (stored) => stored.sequence > afterSequence && stored.event.type === eventType,
          ),
        ),
      latestDomainEventSequence: Ref.get(sequence),
      getThreadShell: () =>
        Effect.succeed({
          projectId: "project:test",
          archivedAt: null,
          deletedAt: null,
        } as never),
      getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
      sendToThread: (message) =>
        Ref.update(sends, (all) => [...all, message]).pipe(Effect.as({} as never)),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: (request) =>
        Ref.get(landed).pipe(
          Effect.map((isLanded) => ({
            exitCode: ChildProcessSpawner.ExitCode(
              request.args[0] === "rev-parse" || isLanded ? 0 : 1,
            ),
            stdout: "0123456789abcdef0123456789abcdef01234567\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          })),
        ),
    }),
  );
  return {
    tick: Ref.get(tick).pipe(Effect.flatten),
    sends,
    publish,
    landed,
    layer: ScheduledTaskService.layer.pipe(Layer.provide(dependencies)),
  };
});

it.effect.each([
  { type: "thread_finished", threadId: "thread:child" },
  { type: "task_finished", task: "step 3" },
  { type: "git_landed", repoPath: "/repo", ref: "feature" },
] as const)("wakes once for $type, persists across restart, and can be cancelled", (wakeWhen) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const created = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decode({ ...input, schedule: { type: "interval", everyMs: 60_000, wakeWhen } }),
      );
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(0);
      return created;
    }).pipe(Effect.provide(f.layer));
    if (wakeWhen.type === "thread_finished") {
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('child-run', 'thread:child', 1, 'codex', 'completed', '2026-01-01T00:00:00Z', '{}')`;
    } else if (wakeWhen.type === "task_finished") {
      yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      VALUES ('task-3', 'thread:main', 'root', 'codex', 'app_owned', 'completed', '2026-01-01T00:00:00Z', '{"title":"step 3"}')`;
    } else yield* Ref.set(f.landed, true);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.setEnabled({ id: created.task.id, enabled: false });
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(0);
      yield* service.setEnabled({ id: created.task.id, enabled: true });
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      const sent = yield* Ref.get(f.sends);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.origin).toMatchObject({ kind: "wake" });
      // The wake lands in the user's own conversation, so it carries no automation preface.
      expect(sent[0]?.text).toBe(input.prompt);
      expect((yield* service.list()).tasks[0]?.enabled).toBe(false);
      yield* TestClock.adjust("2 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([false, true])("check-ins skip unchanged state unless alwaysRun=%s", (alwaysRun) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* decode({
          ...input,
          schedule: { type: "interval", everyMs: 60_000, checkin: true, alwaysRun },
        }),
      );
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(alwaysRun ? 2 : 1);
      expect((yield* service.list()).tasks[0]?.lastRunStatus).toBe(
        alwaysRun ? "succeeded" : "skipped",
      );
      const { runs } = yield* service.listRuns({ id: task.id });
      expect(runs).toHaveLength(2);
      expect(runs[0]?.status).toBe(alwaysRun ? "running" : "skipped");
      expect(runs[0]?.trigger.type).toBe("schedule");
      // Changing a wake condition is new work, even when no child changed.
      yield* service.upsert(
        yield* decode({
          ...input,
          commandId: "other-wake",
          schedule: {
            type: "interval",
            everyMs: 60_000,
            wakeWhen: { type: "thread_finished", threadId: "other" },
          },
        }),
      );
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(alwaysRun ? 3 : 2);
      yield* service.delete({ id: task.id });
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("idle check-ins retain their baseline across restart and detect queue changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(
        yield* decode({
          ...input,
          schedule: { type: "interval", everyMs: 1_800_000, idleCheckin: true },
        }),
      );
      yield* TestClock.adjust("30 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* TestClock.adjust("30 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(1);
      expect((yield* service.list()).tasks[0]?.lastRunStatus).toBe("skipped");
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('queued', 'thread:main', 1, 'codex', 'queued', '2026-01-01T00:00:00Z', '{}')`;
      yield* TestClock.adjust("30 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(1);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'cancelled' WHERE run_id = 'queued'`;
      yield* TestClock.adjust("30 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(2);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("idle check-ins reset on terminal runs and never fire during work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const { task } = yield* service.upsert(
        yield* decode({
          ...input,
          schedule: { type: "interval", everyMs: 1_800_000, idleCheckin: true },
        }),
      );
      const updates = yield* Queue.unbounded<unknown>();
      yield* service.subscribeList().pipe(
        Stream.runForEach((list) => Queue.offer(updates, list)),
        Effect.forkScoped,
      );
      yield* Queue.take(updates);
      const startedAt = yield* DateTime.now;
      const run: OrchestrationV2Run = {
        id: RunId.make("idle-run"),
        threadId: ThreadId.make(input.threadId),
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make("idle-input"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: startedAt,
        startedAt,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const publish = (value: OrchestrationV2Run) =>
        Effect.gen(function* () {
          const event: OrchestrationV2DomainEvent = {
            id: EventId.make(`idle:${value.status}:${value.ordinal}`),
            type: "run.updated",
            threadId: value.threadId,
            runId: value.id,
            occurredAt: yield* DateTime.now,
            payload: value,
          };
          yield* store.apply(event);
          yield* f.publish(event);
          yield* Queue.take(updates);
        });
      yield* publish(run);
      yield* TestClock.adjust("30 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(0);
      yield* Queue.take(updates);
      const completedAt = yield* DateTime.now;
      yield* publish({ ...run, status: "completed", completedAt });
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(
        DateTime.formatIso(DateTime.addDuration(completedAt, 1_800_000)),
      );
      yield* TestClock.adjust("29 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(0);
      yield* publish({
        ...run,
        id: RunId.make("idle-run-2"),
        ordinal: 2,
        status: "completed",
        completedAt: yield* DateTime.now,
      });
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(0);
      yield* TestClock.adjust("29 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(1);
      expect(
        (yield* service.list()).tasks.find((entry) => entry.id === task.id)?.lastRunStatus,
      ).toBe("succeeded");
    }).pipe(Effect.provide(Layer.mergeAll(f.layer, ProjectionStore.layer)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { wakeWhen: { type: "thread_finished", threadId: "thread:child" }, kind: "run" },
  { wakeWhen: { type: "task_finished", task: "step 3" }, kind: "subagent" },
] as const)(
  "a $wakeWhen.type wake fires on its event, not after the interval",
  ({ wakeWhen, kind }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const updates =
          yield* Queue.unbounded<ReadonlyArray<{ readonly nextRunAt: string | null }>>();
        yield* service.subscribeList().pipe(
          Stream.runForEach((list) => Queue.offer(updates, list.tasks)),
          Effect.forkScoped,
        );
        yield* service.upsert(
          yield* decode({ ...input, schedule: { type: "interval", everyMs: 3_600_000, wakeWhen } }),
        );
        // The save checks once; an unmet condition then waits for its event, with a slow backstop.
        yield* f.tick;
        expect(yield* Ref.get(f.sends)).toHaveLength(0);
        const occurredAt = yield* DateTime.now;
        const nowIso = DateTime.formatIso(occurredAt);
        expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(
          DateTime.formatIso(DateTime.addDuration(occurredAt, EVENT_WAKE_BACKSTOP_MS)),
        );
        if (kind === "run") {
          yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('child-run', 'thread:child', 1, 'codex', 'completed', '1970-01-01T00:00:00Z', '{}')`;
          yield* f.publish({
            id: EventId.make("child-run:completed"),
            type: "run.updated",
            threadId: ThreadId.make("thread:child"),
            occurredAt,
            payload: { threadId: ThreadId.make("thread:child"), status: "completed" },
          } as unknown as OrchestrationV2DomainEvent);
        } else {
          yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
        VALUES ('task-3', 'thread:main', 'root', 'codex', 'app_owned', 'completed', '1970-01-01T00:00:00Z', '{"title":"step 3"}')`;
          yield* f.publish({
            id: EventId.make("task-3:completed"),
            type: "subagent.updated",
            threadId: ThreadId.make(input.threadId),
            occurredAt,
            payload: { threadId: ThreadId.make(input.threadId), status: "completed" },
          } as unknown as OrchestrationV2DomainEvent);
        }
        // Buffered emissions can predate the event, so check stored state after each change.
        while ((yield* service.list()).tasks[0]?.nextRunAt !== nowIso) yield* Queue.take(updates);
        // No clock advance: the event made the wake due now.
        yield* f.tick;
        const sent = yield* Ref.get(f.sends);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.origin).toMatchObject({ kind: "wake" });
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a missed wake event is caught by the backstop check", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(
        yield* decode({
          ...input,
          schedule: {
            type: "interval",
            everyMs: 3_600_000,
            wakeWhen: { type: "thread_finished", threadId: "thread:child" },
          },
        }),
      );
      yield* f.tick;
      // The run finishes but no event arrives, as when the stream is down.
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('child-run', 'thread:child', 1, 'codex', 'completed', '1970-01-01T00:00:00Z', '{}')`;
      yield* TestClock.adjust("4 minutes");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(0);
      yield* TestClock.adjust("1 minute");
      yield* f.tick;
      expect(yield* Ref.get(f.sends)).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("the wake event moves an already-due wake so a stale unmet check cannot clear it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* decode({
          ...input,
          schedule: {
            type: "interval",
            everyMs: 3_600_000,
            wakeWhen: { type: "thread_finished", threadId: "thread:child" },
          },
        }),
      );
      // A scheduler pass read the wake as due at this time and found the child still running.
      const staleDue = (yield* service.list()).tasks[0]?.nextRunAt ?? null;
      expect(staleDue).not.toBeNull();
      yield* TestClock.adjust("1 second");
      const occurredAt = yield* DateTime.now;
      const woken = yield* EventTriggers.dueWakesForEvent(
        {
          id: EventId.make("child-run:completed"),
          type: "run.updated",
          threadId: ThreadId.make("thread:child"),
          occurredAt,
          payload: { threadId: ThreadId.make("thread:child"), status: "completed" },
        } as unknown as OrchestrationV2DomainEvent,
        occurredAt,
      );
      expect(woken).toHaveLength(1);
      // That pass's guarded "unmet, wait for the event" write now misses.
      const cleared = yield* sql`UPDATE scheduled_tasks SET next_run_at = NULL
        WHERE task_id = ${task.id} AND next_run_at = ${staleDue} RETURNING task_id`;
      expect(cleared).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
