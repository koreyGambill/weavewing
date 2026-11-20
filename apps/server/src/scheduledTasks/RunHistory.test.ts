import { assert, it } from "@effect/vitest";
import {
  RunId,
  ScheduledTaskId,
  type ScheduledTaskListRunsResult,
  ScheduledTaskRunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { parseRateTable, priceUsage } from "../usage/usagePricing.ts";
import * as RunHistory from "./RunHistory.ts";

it.effect("keeps the newest runs per task and pages through them newest first", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    for (const id of ["task:a", "task:b"]) {
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: id,
        title: "task",
        prompt: "Run task",
        enabled: 1,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: "project:test",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: now,
        updated_at: now,
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
    }
    const taskId = ScheduledTaskId.make("task:a");
    const total = RunHistory.RUN_RETENTION_PER_TASK + 5;
    // Two runs share each start time, so the cursor must break ties.
    const at = (index: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) + Math.floor(index / 2) * 1_000));
    const skip = (index: number, id: string) =>
      RunHistory.recordSkip({
        id: ScheduledTaskRunId.make(id),
        taskId,
        at: at(index),
        trigger: { type: "schedule", summary: "On schedule" },
      });
    // Old skips that the retention window later passes, then runs with skips between them.
    yield* skip(0, "skip:old");
    for (let index = 0; index < total; index++) {
      yield* RunHistory.startRun({
        id: ScheduledTaskRunId.make(`run:${index}`),
        taskId,
        startedAt: at(index),
        trigger: { type: "schedule", summary: "On schedule" },
      });
      yield* RunHistory.prune(taskId);
      for (const repeat of [1, 2, 3]) yield* skip(index, `skip:${index}:${repeat}`);
    }
    yield* RunHistory.startRun({
      id: ScheduledTaskRunId.make("run:other-task"),
      taskId: ScheduledTaskId.make("task:b"),
      startedAt: now,
      trigger: { type: "manual", summary: "Run now" },
    });

    const kept = yield* sql<{ id: string; skip_count: number }>`SELECT id, skip_count
      FROM scheduled_task_runs WHERE task_id = ${taskId} AND status != 'skipped'`;
    assert.lengthOf(kept, RunHistory.RUN_RETENTION_PER_TASK);
    assert.isFalse(kept.some((row) => row.id === "run:4"));
    assert.isTrue(kept.some((row) => row.id === "run:5"));
    // Three skips after each run collapse into one row, and skips never evict runs.
    const skips = yield* sql<{ id: string; skip_count: number }>`SELECT id, skip_count
      FROM scheduled_task_runs WHERE task_id = ${taskId} AND status = 'skipped'`;
    assert.lengthOf(skips, RunHistory.RUN_RETENTION_PER_TASK);
    assert.isTrue(skips.every((row) => row.skip_count === 3 && row.id.endsWith(":1")));
    assert.isFalse(skips.some((row) => row.id === "skip:old"));

    const seen: Array<string> = [];
    let before: ScheduledTaskRunId | undefined;
    let pages = 0;
    for (;;) {
      const page = yield* RunHistory.listRuns(taskId, before);
      pages++;
      seen.push(...page.runs.map((run) => run.id));
      if (!page.hasMore) break;
      before = page.runs.at(-1)?.id;
    }
    assert.equal(
      pages,
      Math.ceil((RunHistory.RUN_RETENTION_PER_TASK * 2) / RunHistory.RUNS_PAGE_SIZE),
    );
    assert.lengthOf(seen, RunHistory.RUN_RETENTION_PER_TASK * 2);
    assert.equal(seen[0], `skip:${total - 1}:1`);
    assert.equal(seen[1], `run:${total - 1}`);
    assert.equal(seen.at(-1), "run:5");
    assert.equal(new Set(seen).size, seen.length);

    const allRuns: Array<string> = [];
    before = undefined;
    for (;;) {
      const page: ScheduledTaskListRunsResult = yield* RunHistory.listRuns(undefined, before);
      allRuns.push(...page.runs.map((run) => run.id));
      if (!page.hasMore) break;
      before = page.runs.at(-1)?.id;
    }
    assert.deepEqual(allRuns, [...seen, "run:other-task"]);

    const [skipped] = yield* sql<{
      last_run_ended_at: string | null;
    }>`SELECT last_run_ended_at FROM scheduled_tasks WHERE task_id = ${taskId}`;
    assert.equal(skipped?.last_run_ended_at, at(total - 1));
    const closedNow = yield* RunHistory.finishRun(ScheduledTaskRunId.make(`run:${total - 1}`), {
      status: "quiet",
      endedAt: now,
      error: null,
      cost: { tokens: 12, costUsd: 0.01, otherTokens: null, otherCostUsdEstimate: null },
    });
    assert.isTrue(closedNow);
    // A closed run keeps its first outcome.
    yield* RunHistory.finishRun(ScheduledTaskRunId.make(`run:${total - 1}`), {
      status: "failed",
      endedAt: now,
      error: "late",
    });
    const [, newest] = (yield* RunHistory.listRuns(taskId, undefined)).runs;
    assert.deepInclude(newest, {
      status: "quiet",
      endedAt: now,
      error: null,
      tokens: 12,
      costUsd: 0.01,
    });
    const [task] = yield* sql<{
      last_run_ended_at: string | null;
    }>`SELECT last_run_ended_at FROM scheduled_tasks WHERE task_id = ${taskId}`;
    assert.equal(task?.last_run_ended_at, now);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// Numbers from the claude_nested_subagent_model fixture: a Sonnet root whose Haiku subagent and
// nested subagent the ledger reports only as `otherUsage`. Claude reported Haiku's part as $0.0771.
it.effect("prices subagent usage apart, at the subagent model with the main cache shares", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:nested");
    const runId = RunId.make("run:nested");
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
      VALUES ('attempt:1', ${threadId}, ${runId}, 1, 'node:root', 'claude', 'pt:1', 'completed', '{}')`;
    const turn = (id: string, ordinal: number, usage: object) =>
      sql`INSERT INTO orchestration_v2_projection_provider_turns
        (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, payload_json)
        VALUES (${id}, ${threadId}, 'pt:1', 'node:root', 'attempt:1', ${ordinal}, 'completed',
          ${JSON.stringify({ turnTokenUsage: usage })})`;
    yield* turn("turn:root", 1, {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: true,
      inputTokens: 74_167,
      cachedInputTokens: 36_863,
      cacheCreationTokens: 37_300,
      outputTokens: 236,
      reasoningTokens: 30,
      models: ["claude-sonnet-4-6"],
      otherUsage: { inputTokens: 87_409, outputTokens: 335 },
    });
    // A local command's counters are not model work.
    yield* turn("turn:local", 2, {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      localCommand: true,
      inputTokens: 900_000,
      outputTokens: 900_000,
      models: ["claude-sonnet-4-6"],
    });
    const subagent = (id: string, origin: string, model: string) =>
      sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, 'node:root', 'claude', ${origin}, 'completed', '2026-01-01T00:00:00Z',
          ${JSON.stringify({ runId, model })})`;
    yield* subagent("subagent:outer", "provider_native", "claude-haiku-4-5");
    yield* subagent("subagent:nested", "provider_native", "claude-haiku-4-5");
    // Delegated work runs in its own thread and is not in this ledger.
    yield* subagent("subagent:delegated", "app_owned", "claude-opus-4-1");

    const usage = yield* RunHistory.runUsage(threadId, runId);
    assert.equal(usage.tokens, 74_167 + 236);
    assert.equal(usage.otherTokens, 87_409 + 335);
    assert.deepEqual(
      usage.records.map((record) => [record.model, record.totals]),
      [
        [
          "claude-sonnet-4-6",
          {
            uncachedInputTokens: 4,
            cachedInputTokens: 36_863,
            cacheCreationTokens: 37_300,
            outputTokens: 236,
            reasoningTokens: 30,
          },
        ],
      ],
    );
    const [other] = usage.otherRecords;
    assert.equal(other?.model, "claude-haiku-4-5");
    assert.equal(
      (other?.totals.uncachedInputTokens ?? 0) +
        (other?.totals.cachedInputTokens ?? 0) +
        (other?.totals.cacheCreationTokens ?? 0),
      87_409,
    );

    const rates = parseRateTable({
      "claude-sonnet-4-6": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        cache_read_input_token_cost: 0.3e-6,
        cache_creation_input_token_cost: 3.75e-6,
      },
      "claude-haiku-4-5": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
        cache_read_input_token_cost: 0.1e-6,
        cache_creation_input_token_cost: 1.25e-6,
      },
    });
    const estimate = other === undefined ? 0 : priceUsage(rates, other).costUsd;
    // Pricing it all as uncached Sonnet input, as before, came to about $0.27.
    assert.isAbove(estimate, 0.0771 * 0.7);
    assert.isBelow(estimate, 0.0771 * 1.3);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
