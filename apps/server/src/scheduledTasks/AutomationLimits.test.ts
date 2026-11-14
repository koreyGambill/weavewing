import { assert, it } from "@effect/vitest";
import { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as AutomationLimits from "./AutomationLimits.ts";
import * as RunHistory from "./RunHistory.ts";

const now = "2026-11-14T00:00:00.000Z";
const haiku = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };

const insertTask = (
  sql: SqlClient.SqlClient,
  id: string,
  threadId: string | null,
  grant: object | null,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: id,
    title: id,
    prompt: "Check",
    enabled: 1,
    schedule_json: '{"type":"interval","everyMs":3600000}',
    project_id: "project:test",
    thread_id: threadId,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: JSON.stringify(haiku),
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    last_run_status: "running",
    run_count: 0,
    grant_json: grant === null ? null : JSON.stringify(grant),
  })}`;

const insertThread = (
  sql: SqlClient.SqlClient,
  id: string,
  parent: { readonly id: string; readonly relationship: "subagent" | "fork" } | null = null,
) =>
  sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
    thread_id: id,
    project_id: "project:test",
    title: id,
    default_provider: "claudeAgent",
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_at: now,
    updated_at: now,
    payload_json: JSON.stringify({
      lineage: {
        parentThreadId: parent?.id ?? null,
        relationshipToParent: parent?.relationship ?? null,
        rootThreadId: parent?.id ?? id,
      },
    }),
  })}`;

const insertMessage = (sql: SqlClient.SqlClient, id: string, threadId: string, payload: object) =>
  sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
    message_id: id,
    thread_id: threadId,
    role: "user",
    streaming: 0,
    created_at: now,
    updated_at: now,
    payload_json: JSON.stringify(payload),
  })}`;

const insertRun = (
  sql: SqlClient.SqlClient,
  run: { id: string; threadId: string; ordinal?: number; status?: string; message?: object },
) =>
  Effect.gen(function* () {
    if (run.message !== undefined)
      yield* insertMessage(sql, `message:${run.id}`, run.threadId, run.message);
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: run.id,
      thread_id: run.threadId,
      ordinal: run.ordinal ?? 1,
      provider: "claudeAgent",
      status: run.status ?? "running",
      requested_at: now,
      payload_json: JSON.stringify(
        run.message === undefined ? {} : { userMessageId: `message:${run.id}` },
      ),
    })}`;
  });

// Threads a task started have ids that name it; every turn there is limited, a person's too.
const launched = "automation-thread:task:launching:1";
const ownedEarlier = "automation-thread:task:owned:1";
const owned = "automation-thread:task:owned:2";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A thread a person started, bound to a limited task: only the task's runs are limited.
  yield* insertTask(sql, "task:bound", "thread:bound", {
    subagents: { max: 2, models: [] },
    budget: { maxCostUsd: 0.5 },
  });
  yield* insertTask(sql, "task:launching", null, { maxRunsPerHour: 2 });
  yield* insertTask(sql, "task:owned", null, { budget: { maxTokens: 1_000_000 } });
  yield* insertTask(sql, "task:user", "thread:user", { budget: { maxTokens: 1_000_000 } });
  yield* insertTask(sql, "task:unlimited", "thread:unlimited", null);
  yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
    id: "run:bound",
    task_id: "task:bound",
    started_at: now,
    status: "running",
    trigger_json: '{"type":"schedule","summary":"On schedule"}',
    thread_id: "thread:bound",
    orchestration_run_id: "orun:bound",
  })}`;
  for (const id of ["thread:bound", launched, ownedEarlier, owned, "thread:unlimited"]) {
    yield* insertThread(sql, id);
  }
  yield* insertThread(sql, "thread:child", { id: "thread:bound", relationship: "subagent" });
  yield* insertThread(sql, "thread:grandchild", { id: "thread:child", relationship: "subagent" });
  yield* insertThread(sql, "thread:fork", { id: "thread:bound", relationship: "fork" });
  // A person's fork of a task's thread, bound to a task before anyone wrote in it.
  yield* insertThread(sql, "thread:user", { id: ownedEarlier, relationship: "fork" });
  yield* insertRun(sql, {
    id: "orun:bound",
    threadId: "thread:bound",
    message: { scheduledTaskId: "task:bound" },
  });
  yield* insertRun(sql, { id: "orun:child", threadId: "thread:child" });
  // The user chatting in a thread the task started.
  yield* insertRun(sql, { id: "orun:owned", threadId: owned, message: {} });
});

it.effect("limits a task's own threads, and only its runs in a thread a person started", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const scopeOf = (id: string) =>
      AutomationLimits.automationForThread(ThreadId.make(id)).pipe(
        Effect.map((scope) => scope?.taskId ?? null),
      );
    assert.equal(yield* scopeOf("thread:bound"), "task:bound");
    assert.equal(yield* scopeOf("thread:grandchild"), "task:bound");
    assert.equal(yield* scopeOf(launched), "task:launching");
    assert.equal(yield* scopeOf(owned), "task:owned");
    assert.equal(yield* scopeOf("thread:fork"), null);
    assert.equal(yield* scopeOf("thread:unlimited"), null);

    // The fork's first message comes from the task, yet a person started the thread.
    yield* insertRun(sql, {
      id: "orun:user-task",
      threadId: "thread:user",
      message: { scheduledTaskId: "task:user" },
    });
    assert.equal(yield* scopeOf("thread:user"), "task:user");
    yield* insertRun(sql, {
      id: "orun:user-chat",
      threadId: "thread:user",
      ordinal: 2,
      message: {},
    });
    assert.equal(yield* scopeOf("thread:user"), null);
    // An agent's follow-up keeps the run it follows: still the person's.
    yield* insertRun(sql, {
      id: "orun:user-follow-up",
      threadId: "thread:user",
      ordinal: 3,
      message: { senderThreadId: "thread:user" },
    });
    assert.equal(yield* scopeOf("thread:user"), null);

    // A delegated thread keeps the run that spawned it: one from the task's run stays limited
    // while the person's turn runs, and so does its own delegated thread; one from the person's
    // turn is not limited.
    const delegated = (child: string, runId: string) =>
      Effect.gen(function* () {
        yield* insertThread(sql, child, { id: "thread:user", relationship: "subagent" });
        yield* sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert({
          subagent_id: `subagent:${child}`,
          thread_id: "thread:user",
          run_id: runId,
          parent_node_id: "node:root",
          provider: "claudeAgent",
          child_thread_id: child,
          origin: "app_owned",
          status: "running",
          updated_at: now,
          payload_json: "{}",
        })}`;
      });
    yield* delegated("thread:task-child", "orun:user-task");
    yield* delegated("thread:chat-child", "orun:user-chat");
    yield* insertThread(sql, "thread:task-grandchild", {
      id: "thread:task-child",
      relationship: "subagent",
    });
    for (const id of ["thread:task-child", "thread:task-grandchild"]) {
      const scope = yield* AutomationLimits.automationForThread(ThreadId.make(id));
      assert.deepEqual([scope?.taskId, scope?.runId], ["task:user", "orun:user-task"]);
    }
    assert.equal(yield* scopeOf("thread:chat-child"), null);

    const base = Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
      resolve: () =>
        Effect.succeed(
          ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        ),
    });
    const resolve = (id: string) =>
      RuntimePolicy.RuntimePolicyV2.pipe(
        Effect.flatMap((policy) =>
          policy.resolve({ thread: { id } as never, modelSelection: haiku as never }),
        ),
        Effect.map((policy) => policy.disableNativeSubagents ?? false),
        Effect.provide(AutomationLimits.runtimePolicyLayer.pipe(Layer.provide(base))),
      );
    assert.isTrue(yield* resolve("thread:child"));
    assert.isTrue(yield* resolve(owned));
    assert.isFalse(yield* resolve("thread:user"));
    // Only a run cap: native subagents stay.
    assert.isFalse(yield* resolve(launched));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : "allowed")),
  );

it.effect("keeps a limited automation's agents inside its limits", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const events = yield* Queue.unbounded<never>();
    const interrupts = yield* Ref.make<Array<string>>([]);
    const cancelled = yield* Ref.make<Array<string>>([]);
    const barrier = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const childAgain = yield* Deferred.make<void>();
    const count = (all: ReadonlyArray<string>, id: string) =>
      all.filter((entry) => entry === id).length;
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      streamDomainEvents: Stream.fromQueue(events),
      dispatch: (command) =>
        Ref.update(cancelled, (all) => [...all, (command as { runId: string }).runId]).pipe(
          Effect.as({} as never),
        ),
      interruptThread: (input) =>
        Ref.updateAndGet(interrupts, (all) => [...all, input.threadId]).pipe(
          Effect.tap((all) =>
            Effect.all([
              all.includes(owned) ? Deferred.succeed(barrier, undefined) : Effect.void,
              all.includes("thread:bound") && all.includes("thread:child")
                ? Deferred.succeed(interrupted, undefined)
                : Effect.void,
              count(all, "thread:child") === 2
                ? Deferred.succeed(childAgain, undefined)
                : Effect.void,
            ]),
          ),
          Effect.as({ type: "no_active_run" } as const),
        ),
    });
    // $1 per million input tokens, $10 per million output tokens.
    const usage = Layer.mock(UsageService.UsageService)({
      priceRecords: (records) =>
        Effect.succeed(
          records.reduce(
            (total, record) =>
              total +
              (record.totals.uncachedInputTokens + record.totals.cachedInputTokens) / 1e6 +
              record.totals.outputTokens / 1e5,
            0,
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const limits = yield* AutomationLimits.AutomationLimits;
      const child = ThreadId.make("thread:child");
      const admit = (models: ReadonlyArray<{ instanceId: string; model: string }>) =>
        failure(limits.admitSubagents({ callerThreadId: child, models }));
      const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
      assert.include(yield* admit([opus]), "only on claudeAgent/claude-haiku-5-5");
      assert.equal(yield* admit([haiku, haiku]), "allowed");
      assert.include(yield* admit([haiku]), "This automation allows 2 subagents per run.");
      const [row] = yield* sql<{ subagent_count: number }>`
        SELECT subagent_count FROM scheduled_task_runs WHERE id = 'run:bound'`;
      assert.equal(row?.subagent_count, 2);

      // Creating tasks, changing limits and running tasks now are refused in any limited thread.
      for (const id of ["thread:child", launched, owned]) {
        assert.include(
          yield* failure(limits.refuseScheduling(ThreadId.make(id))),
          "can't create tasks, change limits or run tasks now",
        );
      }
      assert.equal(
        yield* failure(limits.refuseScheduling(ThreadId.make("thread:other"))),
        "allowed",
      );
      // New threads would escape the budget, a budget-only one included.
      for (const id of ["thread:child", owned]) {
        assert.include(
          yield* failure(limits.refuseOutside(ThreadId.make(id), "start new threads")),
          "so it can't start new threads",
        );
      }
      assert.equal(
        yield* failure(limits.refuseOutside(ThreadId.make(launched), "start new threads")),
        "allowed",
      );

      const send = (from: string, to: string) =>
        failure(
          limits.admitSend({
            callerThreadId: ThreadId.make(from),
            targetThreadId: ThreadId.make(to),
          }),
        );
      assert.include(yield* send("thread:child", "thread:unlimited"), "send to threads outside it");
      assert.equal(yield* send("thread:child", "thread:bound"), "allowed");
      // A thread an earlier run of the same task started has a budget of its own.
      assert.include(yield* send(owned, ownedEarlier), "send to threads outside it");
      assert.equal(yield* send(owned, owned), "allowed");
      // A thread with no run of its own to count toward is refused.
      assert.include(yield* send(ownedEarlier, ownedEarlier), "could not be found");
      const elsewhere = (to: string) =>
        failure(
          limits.refuseOtherThread({
            callerThreadId: child,
            targetThreadId: ThreadId.make(to),
            action: "answer requests in threads outside it",
          }),
        );
      assert.include(yield* elsewhere("thread:unlimited"), "answer requests in threads outside it");
      assert.equal(yield* elsewhere("thread:bound"), "allowed");

      // Follow-ups its agents sent count toward its runs per hour, from history, so the
      // scheduler sees them too: one scheduled run plus one follow-up reach a cap of 2.
      yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
        id: "run:launched",
        task_id: "task:launching",
        started_at: now,
        status: "running",
        trigger_json: '{"type":"schedule","summary":"On schedule"}',
        thread_id: launched,
      })}`;
      yield* insertRun(sql, {
        id: "orun:launched",
        threadId: launched,
        message: { scheduledTaskId: "task:launching" },
      });
      assert.equal(yield* send(launched, launched), "allowed");
      yield* insertRun(sql, {
        id: "orun:launched-follow-up",
        threadId: launched,
        ordinal: 2,
        message: { senderThreadId: launched },
      });
      assert.include(yield* send(launched, launched), "This automation allows 2 runs per hour.");
      assert.equal(
        yield* RunHistory.countRecentRuns(
          ScheduledTaskId.make("task:launching"),
          "2026-11-13T00:00:00.000Z",
        ),
        2,
      );

      const turnUpdate = (threadId: string, turnId: string, tokenUsage: object) =>
        ({
          type: "provider-turn.updated",
          threadId: ThreadId.make(threadId),
          payload: { id: turnId, tokenUsage: { ...tokenUsage, updatedAt: now } },
        }) as never;
      // A context-size update without request counts is not a request: it would be $0.90.
      yield* Queue.offer(events, turnUpdate("thread:child", "turn:1", { usedTokens: 900_000 }));
      // 200k in + 10k out = $0.30.
      const first = { usedTokens: 200_000, inputTokens: 200_000 };
      yield* Queue.offer(
        events,
        turnUpdate("thread:child", "turn:1", { ...first, outputTokens: 1_000 }),
      );
      yield* Queue.offer(
        events,
        turnUpdate("thread:child", "turn:1", { ...first, outputTokens: 10_000 }),
      );
      // A native subagent in a limited thread stops its run; once seen, the events above are in.
      yield* Queue.offer(events, {
        type: "subagent.updated",
        threadId: ThreadId.make(owned),
        payload: { origin: "provider_native" },
      } as never);
      yield* Deferred.await(barrier);
      assert.deepEqual(yield* Ref.get(interrupts), [owned]);

      // However many follow-ups came before, the agent's turns share the run's budget.
      for (let ordinal = 2; ordinal < 62; ordinal++) {
        yield* insertRun(sql, {
          id: `orun:earlier-follow-up-${ordinal}`,
          threadId: "thread:bound",
          ordinal,
          status: "completed",
          message: { senderThreadId: "thread:bound" },
        });
      }
      // A turn the agent queued in its delegated thread is cancelled with the stop.
      yield* insertRun(sql, {
        id: "orun:child-queued",
        threadId: "thread:child",
        ordinal: 2,
        status: "queued",
        message: { senderThreadId: "thread:bound" },
      });
      yield* insertRun(sql, {
        id: "orun:follow-up",
        threadId: "thread:bound",
        ordinal: 100,
        message: { senderThreadId: "thread:bound" },
      });
      // $0.35 more crosses $0.50 only together with the earlier spend.
      const followUp = { usedTokens: 300_000, inputTokens: 300_000, outputTokens: 5_000 };
      yield* Queue.offer(events, turnUpdate("thread:bound", "turn:2", followUp));
      yield* Deferred.await(interrupted);
      assert.deepEqual((yield* Ref.get(interrupts)).toSorted(), [
        owned,
        "thread:bound",
        "thread:child",
      ]);
      assert.include(yield* Ref.get(cancelled), "orun:child-queued");
      const [stopped] = yield* sql<{ status: string; error: string }>`
        SELECT status, error FROM scheduled_task_runs WHERE id = 'run:bound'`;
      assert.deepEqual(stopped, {
        status: "budget_stopped",
        error: "Stopped at the $0.50 run budget.",
      });
      const [task] = yield* sql<{ last_run_status: string; last_run_error: string }>`
        SELECT last_run_status, last_run_error FROM scheduled_tasks WHERE task_id = 'task:bound'`;
      assert.deepEqual(task, {
        last_run_status: "failed",
        last_run_error: "Stopped at the $0.50 run budget.",
      });
      // No more follow-ups or subagents until the next scheduled run.
      assert.include(
        yield* send("thread:child", "thread:bound"),
        "Stopped at the $0.50 run budget.",
      );
      assert.include(yield* admit([haiku]), "Stopped at the $0.50 run budget.");
      // Work of the stopped run that starts later stops where it runs.
      yield* Queue.offer(events, turnUpdate("thread:child", "turn:3", first));
      yield* Deferred.await(childAgain);

      // After a restart the stop and the subagent count come back from the run's history row.
      const restarted = AutomationLimits.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.never,
          }),
        ),
      );
      const afterRestart = yield* AutomationLimits.AutomationLimits.pipe(
        Effect.flatMap((fresh) =>
          Effect.all([
            failure(fresh.admitSubagents({ callerThreadId: child, models: [haiku] })),
            failure(
              fresh.admitSend({
                callerThreadId: child,
                targetThreadId: ThreadId.make("thread:bound"),
              }),
            ),
          ]),
        ),
        Effect.provide(restarted),
      );
      for (const outcome of afterRestart)
        assert.include(outcome, "Stopped at the $0.50 run budget.");
      yield* insertRun(sql, {
        id: "orun:next",
        threadId: "thread:bound",
        ordinal: 101,
        message: { scheduledTaskId: "task:bound" },
      });
      assert.equal(yield* send("thread:child", "thread:bound"), "allowed");
    }).pipe(
      Effect.provide(AutomationLimits.layer.pipe(Layer.provide(Layer.merge(threads, usage)))),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
