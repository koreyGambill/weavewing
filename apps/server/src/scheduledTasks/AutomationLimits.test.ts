import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
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

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* insertTask(sql, "task:bound", "thread:bound", {
    subagents: { max: 2, models: [] },
    budget: { maxCostUsd: 0.5 },
  });
  yield* insertTask(sql, "task:launching", null, { maxRunsPerHour: 2 });
  yield* insertTask(sql, "task:budget", "thread:budget", { budget: { maxTokens: 1_000_000 } });
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
  for (const id of ["thread:bound", "thread:launched", "thread:budget", "thread:unlimited"]) {
    yield* insertThread(sql, id);
  }
  // A launched thread is found by its first message alone, without a run history row.
  yield* insertMessage(sql, "message:launch", "thread:launched", {
    scheduledTaskId: "task:launching",
  });
  yield* insertThread(sql, "thread:child", { id: "thread:bound", relationship: "subagent" });
  yield* insertThread(sql, "thread:grandchild", { id: "thread:child", relationship: "subagent" });
  yield* insertThread(sql, "thread:fork", { id: "thread:bound", relationship: "fork" });
  yield* insertRun(sql, { id: "orun:bound", threadId: "thread:bound", message: {} });
  yield* insertRun(sql, { id: "orun:child", threadId: "thread:child" });
  yield* insertRun(sql, { id: "orun:budget", threadId: "thread:budget" });
});

it.effect("finds the automation a thread runs under through delegated tasks, not forks", () =>
  Effect.gen(function* () {
    yield* seed;
    const scopeOf = (id: string) =>
      AutomationLimits.automationForThread(ThreadId.make(id)).pipe(
        Effect.map((scope) => scope?.taskId ?? null),
      );
    assert.equal(yield* scopeOf("thread:bound"), "task:bound");
    assert.equal(yield* scopeOf("thread:grandchild"), "task:bound");
    assert.equal(yield* scopeOf("thread:launched"), "task:launching");
    assert.equal(yield* scopeOf("thread:fork"), null);
    assert.equal(yield* scopeOf("thread:unlimited"), null);

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
    // Only a run cap: native subagents stay.
    assert.isFalse(yield* resolve("thread:launched"));
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
    const barrier = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      streamDomainEvents: Stream.fromQueue(events),
      interruptThread: (input) =>
        Ref.updateAndGet(interrupts, (all) => [...all, input.threadId]).pipe(
          Effect.tap((all) =>
            Effect.all([
              all.includes("thread:budget") ? Deferred.succeed(barrier, undefined) : Effect.void,
              all.includes("thread:bound") && all.includes("thread:child")
                ? Deferred.succeed(interrupted, undefined)
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
      const admit = (models: ReadonlyArray<{ instanceId?: string; model?: string }>) =>
        failure(limits.admitSubagents({ callerThreadId: child, models }));
      const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
      assert.include(yield* admit([opus]), "only on claudeAgent/claude-haiku-5-5");
      assert.include(yield* admit([{}]), "Name target.providerInstanceId and target.model");
      assert.equal(yield* admit([haiku, haiku]), "allowed");
      assert.include(yield* admit([haiku]), "This automation allows 2 subagents per run.");
      const [row] = yield* sql<{ subagent_count: number }>`
        SELECT subagent_count FROM scheduled_task_runs WHERE id = 'run:bound'`;
      assert.equal(row?.subagent_count, 2);
      // Another automation's run is counted on its own.
      yield* limits.admitSubagents({
        callerThreadId: ThreadId.make("thread:launched"),
        models: [{ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" }],
      });

      // Creating tasks, changing limits and running tasks now are refused in any limited thread.
      for (const id of ["thread:child", "thread:launched"]) {
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
      for (const id of ["thread:child", "thread:budget"]) {
        assert.include(
          yield* failure(limits.refuseOutside(ThreadId.make(id), "start new threads")),
          "so it can't start new threads",
        );
      }
      assert.equal(
        yield* failure(limits.refuseOutside(ThreadId.make("thread:launched"), "start new threads")),
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
      // Answering or reordering turns elsewhere is refused too.
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
        thread_id: "thread:launched",
      })}`;
      assert.equal(yield* send("thread:launched", "thread:launched"), "allowed");
      yield* insertRun(sql, {
        id: "orun:launched-follow-up",
        threadId: "thread:launched",
        ordinal: 2,
        message: { senderThreadId: "thread:launched" },
      });
      assert.include(
        yield* send("thread:launched", "thread:launched"),
        "This automation allows 2 runs per hour.",
      );
      assert.equal(
        yield* RunHistory.countRecentRuns(
          ScheduledTaskId.make("task:launching"),
          "2026-11-13T00:00:00.000Z",
        ),
        2,
      );

      const turnUpdate = (threadId: string, tokenUsage: object) =>
        ({
          type: "provider-turn.updated",
          threadId: ThreadId.make(threadId),
          payload: {
            id: `provider-turn:${threadId}`,
            tokenUsage: { ...tokenUsage, updatedAt: now },
          },
        }) as never;
      // A context-size update without request counts is not a request: it would be $0.90.
      yield* Queue.offer(events, turnUpdate("thread:child", { usedTokens: 900_000 }));
      // 200k in + 10k out = $0.30.
      const first = { usedTokens: 200_000, inputTokens: 200_000 };
      yield* Queue.offer(events, turnUpdate("thread:child", { ...first, outputTokens: 1_000 }));
      yield* Queue.offer(events, turnUpdate("thread:child", { ...first, outputTokens: 10_000 }));
      // A native subagent in a limited thread stops its run; once seen, the events above are in.
      yield* Queue.offer(events, {
        type: "subagent.updated",
        threadId: ThreadId.make("thread:budget"),
        payload: { origin: "provider_native" },
      } as never);
      yield* Deferred.await(barrier);
      assert.deepEqual(yield* Ref.get(interrupts), ["thread:budget"]);

      // The agent's follow-up turn shares the run's budget: $0.35 more crosses $0.50.
      yield* insertRun(sql, {
        id: "orun:follow-up",
        threadId: "thread:bound",
        ordinal: 2,
        message: { senderThreadId: "thread:bound" },
      });
      const followUp = { usedTokens: 300_000, inputTokens: 300_000, outputTokens: 5_000 };
      yield* Queue.offer(events, turnUpdate("thread:bound", followUp));
      yield* Deferred.await(interrupted);
      assert.deepEqual((yield* Ref.get(interrupts)).toSorted(), [
        "thread:bound",
        "thread:budget",
        "thread:child",
      ]);
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
      // No more follow-ups until the next scheduled run.
      assert.include(
        yield* send("thread:child", "thread:bound"),
        "Stopped at the $0.50 run budget.",
      );
      // After a restart, the run's subagents come back from its history row.
      const restarted = AutomationLimits.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.never,
          }),
        ),
      );
      assert.include(
        yield* AutomationLimits.AutomationLimits.pipe(
          Effect.flatMap((fresh) =>
            failure(fresh.admitSubagents({ callerThreadId: child, models: [haiku] })),
          ),
          Effect.provide(restarted),
        ),
        "This automation allows 2 subagents per run.",
      );
      yield* insertRun(sql, {
        id: "orun:next",
        threadId: "thread:bound",
        ordinal: 3,
        message: { scheduledTaskId: "task:bound" },
      });
      assert.equal(yield* send("thread:child", "thread:bound"), "allowed");
    }).pipe(
      Effect.provide(AutomationLimits.layer.pipe(Layer.provide(Layer.merge(threads, usage)))),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
