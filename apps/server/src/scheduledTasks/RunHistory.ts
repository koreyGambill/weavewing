import {
  MessageId,
  type RunId,
  ScheduledTaskId,
  type ScheduledTaskListRunsResult,
  type ScheduledTaskRun,
  ScheduledTaskRunId,
  type ScheduledTaskRunOutcome,
  ThreadId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PricedRecord } from "../usage/usagePricing.ts";

export const RUN_RETENTION_PER_TASK = 200;
export const RUNS_PAGE_SIZE = 50;

export interface RunTrigger {
  readonly type: "schedule" | "webhook" | "event" | "manual" | "agent";
  readonly summary: string;
}

interface RunRow {
  readonly id: string;
  readonly task_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly status: string;
  readonly trigger_json: string;
  readonly thread_id: string | null;
  readonly message_id: string | null;
  readonly orchestration_run_id: string | null;
  readonly cost_usd: number | null;
  readonly tokens: number | null;
  readonly other_tokens: number | null;
  readonly other_cost_usd_estimate: number | null;
  readonly skip_count: number;
  readonly subagent_count: number;
  readonly notification_ids_json: string;
  readonly error: string | null;
}

const TriggerJson = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, summary: Schema.String }),
);
const decodeTrigger = Schema.decodeUnknownOption(TriggerJson);
const encodeTrigger = Schema.encodeSync(TriggerJson);
const NotificationIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeNotificationIds = Schema.decodeUnknownOption(NotificationIdsJson);
const encodeNotificationIds = Schema.encodeSync(NotificationIdsJson);
const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));

/** Inserts an open run. Callers prune once they decide to keep it. */
export const startRun = Effect.fn("ScheduledTaskRunHistory.startRun")(function* (input: {
  readonly id: ScheduledTaskRunId;
  readonly taskId: ScheduledTaskId;
  readonly startedAt: string;
  readonly trigger: RunTrigger;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
    id: input.id,
    task_id: input.taskId,
    started_at: input.startedAt,
    status: "running",
    trigger_json: encodeTrigger(input.trigger),
  })}`;
});

/**
 * Keeps the task's newest runs that were not skipped. Skip rows never count toward the limit and
 * go once they are older than every kept run.
 */
export const prune = Effect.fn("ScheduledTaskRunHistory.prune")(function* (
  taskId: ScheduledTaskId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM scheduled_task_runs WHERE task_id = ${taskId}
    AND (started_at, rowid) < (SELECT started_at, rowid FROM scheduled_task_runs
      WHERE task_id = ${taskId} AND status != 'skipped'
      ORDER BY started_at DESC, rowid DESC LIMIT 1 OFFSET ${RUN_RETENTION_PER_TASK - 1})`;
});

/**
 * A skipped check-in extends the newest row when that is a skip too, so idle tasks add one row.
 * It stamps the task's `last_run_ended_at`, so clients refetch the history.
 */
export const recordSkip = Effect.fn("ScheduledTaskRunHistory.recordSkip")(function* (input: {
  readonly id: ScheduledTaskRunId;
  readonly taskId: ScheduledTaskId;
  readonly at: string;
  readonly trigger: RunTrigger;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const extended = yield* sql`UPDATE scheduled_task_runs
        SET ended_at = ${input.at}, skip_count = skip_count + 1
        WHERE id = (SELECT id FROM scheduled_task_runs WHERE task_id = ${input.taskId}
          ORDER BY started_at DESC, rowid DESC LIMIT 1) AND status = 'skipped'
        RETURNING id`;
      yield* sql`UPDATE scheduled_tasks SET last_run_ended_at = ${input.at}
        WHERE task_id = ${input.taskId}`;
      if (extended.length > 0) return;
      yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
        id: input.id,
        task_id: input.taskId,
        started_at: input.at,
        ended_at: input.at,
        status: "skipped",
        trigger_json: encodeTrigger(input.trigger),
        skip_count: 1,
      })}`;
      yield* prune(input.taskId);
    }),
  );
});

export const bindDispatch = Effect.fn("ScheduledTaskRunHistory.bindDispatch")(function* (
  id: ScheduledTaskRunId,
  threadId: ThreadId,
  messageId: MessageId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE scheduled_task_runs SET thread_id = ${threadId}, message_id = ${messageId}
    WHERE id = ${id}`;
});

export const bindOrchestrationRun = Effect.fn("ScheduledTaskRunHistory.bindOrchestrationRun")(
  function* (id: ScheduledTaskRunId, runId: RunId) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE scheduled_task_runs SET orchestration_run_id = ${runId} WHERE id = ${id}`;
  },
);

export interface RunCost {
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly otherTokens: number | null;
  readonly otherCostUsdEstimate: number | null;
}

/**
 * Closes a run once, so a run already closed keeps its first outcome, and stamps its task's
 * `last_run_ended_at`. Returns whether this call closed it.
 */
export const finishRun = Effect.fn("ScheduledTaskRunHistory.finishRun")(function* (
  id: ScheduledTaskRunId,
  outcome: {
    readonly status: Exclude<ScheduledTaskRunOutcome, "running">;
    readonly endedAt: string;
    readonly error: string | null;
    readonly cost?: RunCost | undefined;
    readonly notifications?: ReadonlyArray<string> | undefined;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const closed = yield* sql<{ task_id: string }>`UPDATE scheduled_task_runs
        SET status = ${outcome.status}, ended_at = ${outcome.endedAt}, error = ${outcome.error},
          tokens = ${outcome.cost?.tokens ?? null}, cost_usd = ${outcome.cost?.costUsd ?? null},
          other_tokens = ${outcome.cost?.otherTokens ?? null},
          other_cost_usd_estimate = ${outcome.cost?.otherCostUsdEstimate ?? null},
          notification_ids_json = coalesce(${outcome.notifications === undefined ? null : encodeNotificationIds(outcome.notifications)}, notification_ids_json)
        WHERE id = ${id} AND ended_at IS NULL
        RETURNING task_id`;
      const [row] = closed;
      if (row === undefined) return false;
      yield* sql`UPDATE scheduled_tasks SET last_run_ended_at = ${outcome.endedAt}
        WHERE task_id = ${row.task_id}`;
      return true;
    }),
  );
});

export const deleteRun = Effect.fn("ScheduledTaskRunHistory.deleteRun")(function* (
  id: ScheduledTaskRunId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM scheduled_task_runs WHERE id = ${id}`;
});

/** Runs a previous server process left open. */
export const openRuns = Effect.fn("ScheduledTaskRunHistory.openRuns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    id: string;
    task_id: string;
    started_at: string;
    thread_id: string | null;
    message_id: string | null;
  }>`SELECT id, task_id, started_at, thread_id, message_id FROM scheduled_task_runs
    WHERE ended_at IS NULL`;
  return rows.map((row) => ({
    id: ScheduledTaskRunId.make(row.id),
    taskId: ScheduledTaskId.make(row.task_id),
    startedAt: row.started_at,
    threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
    messageId: row.message_id === null ? null : MessageId.make(row.message_id),
  }));
});

export interface RunUsage {
  readonly tokens: number | null;
  readonly records: ReadonlyArray<PricedRecord>;
  readonly otherTokens: number | null;
  readonly otherRecords: ReadonlyArray<PricedRecord>;
}

const sum = (total: number | null, add: number) => (total ?? 0) + add;

/**
 * The main agent's tokens and priceable records for one orchestration run, kept apart from
 * `otherUsage` (native subagents, compaction). The ledger gives `otherUsage` neither a cache
 * split nor a model, so its records take the turn's main cache shares and the run's most used
 * native subagent model, else the main model: an estimate.
 */
export const runUsage = Effect.fn("ScheduledTaskRunHistory.runUsage")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const sql = yield* SqlClient.SqlClient;
  const turns = yield* sql<{ usage_json: string | null; model: string | null }>`
    SELECT json_extract(t.payload_json, '$.turnTokenUsage') AS usage_json,
      json_extract(t.payload_json, '$.model') AS model
    FROM orchestration_v2_projection_provider_turns t
    JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
    WHERE t.thread_id = ${threadId} AND a.run_id = ${runId}`.pipe(NodeSqliteClient.readOnly);
  const [subagentModel] = yield* sql<{ model: string }>`
    SELECT json_extract(payload_json, '$.model') AS model
    FROM orchestration_v2_projection_subagents
    WHERE thread_id = ${threadId} AND origin = 'provider_native'
      AND json_extract(payload_json, '$.runId') = ${runId}
      AND json_extract(payload_json, '$.model') IS NOT NULL
    GROUP BY model ORDER BY COUNT(*) DESC, model LIMIT 1`.pipe(NodeSqliteClient.readOnly);
  let tokens: number | null = null;
  let otherTokens: number | null = null;
  const records: Array<PricedRecord> = [];
  const otherRecords: Array<PricedRecord> = [];
  for (const turn of turns) {
    const decoded = turn.usage_json === null ? Option.none() : decodeUsage(turn.usage_json);
    // Local commands' counters describe the command's result, not model work.
    if (Option.isNone(decoded) || decoded.value.localCommand === true) continue;
    const usage = decoded.value;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cached = usage.cachedInputTokens ?? 0;
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    tokens = sum(tokens, input + output);
    const model = usage.models?.[0] ?? turn.model;
    if (model !== null) {
      records.push({
        model,
        totals: {
          uncachedInputTokens: Math.max(0, input - cached - cacheCreation),
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: usage.reasoningTokens ?? 0,
        },
        speed: "standard",
        reportedCostUsd: null,
      });
    }
    const other = usage.otherUsage;
    if (other === undefined) continue;
    otherTokens = sum(otherTokens, other.inputTokens + other.outputTokens);
    const otherModel = subagentModel?.model ?? model;
    if (otherModel === null) continue;
    const otherCached = input === 0 ? 0 : Math.round((other.inputTokens * cached) / input);
    const otherCacheCreation =
      input === 0 ? 0 : Math.round((other.inputTokens * cacheCreation) / input);
    otherRecords.push({
      model: otherModel,
      totals: {
        uncachedInputTokens: Math.max(0, other.inputTokens - otherCached - otherCacheCreation),
        cachedInputTokens: otherCached,
        cacheCreationTokens: otherCacheCreation,
        outputTokens: other.outputTokens,
        reasoningTokens: 0,
      },
      speed: "standard",
      reportedCostUsd: null,
    });
  }
  const result: RunUsage = { tokens, records, otherTokens, otherRecords };
  return result;
});

const decodeRun = (row: RunRow): ScheduledTaskRun => {
  const trigger = Option.getOrElse(decodeTrigger(row.trigger_json), () => ({
    type: "unknown",
    summary: "",
  }));
  return {
    id: ScheduledTaskRunId.make(row.id),
    taskId: ScheduledTaskId.make(row.task_id),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    trigger,
    threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
    messageId: row.message_id === null ? null : MessageId.make(row.message_id),
    ...(row.tokens === null ? {} : { tokens: row.tokens }),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
    ...(row.other_tokens === null ? {} : { otherTokens: row.other_tokens }),
    ...(row.other_cost_usd_estimate === null
      ? {}
      : { otherCostUsdEstimate: row.other_cost_usd_estimate }),
    ...(row.subagent_count > 0 ? { subagents: row.subagent_count } : {}),
    ...(row.skip_count > 0 ? { skipCount: row.skip_count } : {}),
    notifications: Option.getOrElse(decodeNotificationIds(row.notification_ids_json), () => []),
    error: row.error,
  };
};

/** Newest first, one page at a time. */
export const listRuns = Effect.fn("ScheduledTaskRunHistory.listRuns")(function* (
  taskId: ScheduledTaskId,
  before: ScheduledTaskRunId | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const cursor =
    before === undefined
      ? sql``
      : sql`AND (started_at, rowid) < (SELECT started_at, rowid FROM scheduled_task_runs
          WHERE id = ${before} AND task_id = ${taskId})`;
  const rows = yield* sql<RunRow>`SELECT * FROM scheduled_task_runs
    WHERE task_id = ${taskId} ${cursor}
    ORDER BY started_at DESC, rowid DESC LIMIT ${RUNS_PAGE_SIZE + 1}`.pipe(
    NodeSqliteClient.readOnly,
  );
  const result: ScheduledTaskListRunsResult = {
    runs: rows.slice(0, RUNS_PAGE_SIZE).map(decodeRun),
    hasMore: rows.length > RUNS_PAGE_SIZE,
  };
  return result;
});
