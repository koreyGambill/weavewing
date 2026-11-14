import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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

const insertRun = (sql: SqlClient.SqlClient, runId: string, threadId: string, status: string) =>
  sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
    run_id: runId,
    thread_id: threadId,
    ordinal: 1,
    provider: "claudeAgent",
    status,
    requested_at: now,
    payload_json: "{}",
  })}`;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const grant = {
    subagents: { max: 2, models: [] },
    budget: { maxCostUsd: 0.5 },
  };
  yield* insertTask(sql, "task:bound", "thread:bound", grant);
  yield* insertTask(sql, "task:launching", null, { maxRunsPerHour: 2 });
  yield* insertTask(sql, "task:unlimited", "thread:unlimited", null);
  yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
    id: "run:launched",
    task_id: "task:launching",
    started_at: now,
    status: "running",
    trigger_json: '{"type":"schedule","summary":"On schedule"}',
    thread_id: "thread:launched",
  })}`;
  yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
    id: "run:bound",
    task_id: "task:bound",
    started_at: now,
    status: "running",
    trigger_json: '{"type":"schedule","summary":"On schedule"}',
    thread_id: "thread:bound",
  })}`;
  for (const id of ["thread:bound", "thread:launched", "thread:unlimited"]) {
    yield* insertThread(sql, id);
  }
  yield* insertThread(sql, "thread:child", { id: "thread:bound", relationship: "subagent" });
  yield* insertThread(sql, "thread:grandchild", { id: "thread:child", relationship: "subagent" });
  yield* insertThread(sql, "thread:fork", { id: "thread:bound", relationship: "fork" });
  yield* insertRun(sql, "orun:bound", "thread:bound", "running");
  yield* insertRun(sql, "orun:child", "thread:child", "running");
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

it.effect("caps subagents per run, allows only listed models, and stops a run over budget", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const events = yield* Queue.unbounded<never>();
    const interrupts = yield* Ref.make<Array<string>>([]);
    const interrupted = yield* Deferred.make<void>();
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      streamDomainEvents: Stream.fromQueue(events),
      interruptThread: (input) =>
        Ref.updateAndGet(interrupts, (all) => [...all, input.threadId]).pipe(
          Effect.tap((all) =>
            all.length === 2 ? Deferred.succeed(interrupted, undefined) : Effect.void,
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
      const admit = (models: ReadonlyArray<typeof haiku>) =>
        limits.admitSubagents({
          callerThreadId: ThreadId.make("thread:child"),
          models: models.map((model) => ({
            instanceId: ProviderInstanceId.make(model.instanceId),
            model: model.model,
          })),
        });
      const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
      const otherModel = yield* Effect.exit(admit([opus]));
      assert.isTrue(Exit.isFailure(otherModel));
      assert.include(String(otherModel), "only on claudeAgent/claude-haiku-5-5");
      yield* admit([haiku, haiku]);
      const third = yield* Effect.exit(admit([haiku]));
      assert.include(String(third), "This automation allows 2 subagents per run.");
      const [row] = yield* sql<{ subagent_count: number }>`
        SELECT subagent_count FROM scheduled_task_runs WHERE id = 'run:bound'`;
      assert.equal(row?.subagent_count, 2);
      // Another automation's run is counted on its own.
      yield* limits.admitSubagents({
        callerThreadId: ThreadId.make("thread:launched"),
        models: [{ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" }],
      });

      const turnUpdate = (input: number, output: number) =>
        ({
          type: "provider-turn.updated",
          threadId: ThreadId.make("thread:child"),
          payload: {
            id: "provider-turn:child",
            tokenUsage: {
              usedTokens: input,
              inputTokens: input,
              outputTokens: output,
              updatedAt: now,
            },
          },
        }) as never;
      // 200k in + 10k out = $0.30, then a second request: 300k in + 5k out = $0.35 more.
      yield* Queue.offer(events, turnUpdate(200_000, 1_000));
      yield* Queue.offer(events, turnUpdate(200_000, 10_000));
      yield* Queue.offer(events, turnUpdate(300_000, 5_000));
      yield* Deferred.await(interrupted);
      assert.deepEqual((yield* Ref.get(interrupts)).toSorted(), ["thread:bound", "thread:child"]);
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
    }).pipe(
      Effect.provide(AutomationLimits.layer.pipe(Layer.provide(Layer.merge(threads, usage)))),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
