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
const decodeNotificationIds = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
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
  },
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // A budget stop marks the row before the interrupted run ends; that outcome stands.
      const closed = yield* sql<{ task_id: string }>`UPDATE scheduled_task_runs
        SET status = CASE WHEN status = 'budget_stopped' THEN status ELSE ${outcome.status} END,
          error = CASE WHEN status = 'budget_stopped' THEN error ELSE ${outcome.error} END,
          ended_at = ${outcome.endedAt},
          tokens = ${outcome.cost?.tokens ?? null}, cost_usd = ${outcome.cost?.costUsd ?? null},
          other_tokens = ${outcome.cost?.otherTokens ?? null},
          other_cost_usd_estimate = ${outcome.cost?.otherCostUsdEstimate ?? null}
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

/** The open run of `threadId` stopped at its budget; its close keeps this outcome. */
export const markBudgetStopped = Effect.fn("ScheduledTaskRunHistory.markBudgetStopped")(function* (
  threadId: ThreadId,
  error: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ task_id: string }>`UPDATE scheduled_task_runs
    SET status = 'budget_stopped', error = ${error}
    WHERE thread_id = ${threadId} AND ended_at IS NULL AND status = 'running'
    RETURNING task_id`;
  return rows.map((row) => ScheduledTaskId.make(row.task_id));
});

/** Runs that count toward the hourly cap: not skipped, capped or started by the user. */
export const countRecentRuns = Effect.fn("ScheduledTaskRunHistory.countRecentRuns")(function* (
  taskId: ScheduledTaskId,
  since: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM scheduled_task_runs
    WHERE task_id = ${taskId} AND started_at > ${since}
      AND status NOT IN ('skipped', 'capped')
      AND json_extract(trigger_json, '$.type') != 'manual'`;
  return row?.count ?? 0;
});

export const recordCapped = Effect.fn("ScheduledTaskRunHistory.recordCapped")(function* (input: {
  readonly id: ScheduledTaskRunId;
  readonly taskId: ScheduledTaskId;
  readonly at: string;
  readonly trigger: RunTrigger;
  readonly error: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
    id: input.id,
    task_id: input.taskId,
    started_at: input.at,
    ended_at: input.at,
    status: "capped",
    trigger_json: encodeTrigger(input.trigger),
    error: input.error,
  })}`;
  yield* sql`UPDATE scheduled_tasks SET last_run_ended_at = ${input.at} WHERE task_id = ${input.taskId}`;
  yield* prune(input.taskId);
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

const pricedRecord = (model: string, totals: PricedRecord["totals"]): PricedRecord => ({
  model,
  totals,
  speed: "standard",
  reportedCostUsd: null,
});

/**
 * One provider turn's main-agent tokens and record, and its `otherUsage` (native subagents,
 * compaction). The ledger gives `otherUsage` neither a cache split nor a model, so its record takes
 * the turn's main cache shares and `otherModel`, else the main model: an estimate.
 */
export function turnUsage(
  usage: TurnTokenUsage,
  turnModel: string | null,
  otherModel: string | null,
) {
  // Local commands' counters describe the command's result, not model work.
  if (usage.localCommand === true) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  const model = usage.models?.[0] ?? turnModel;
  const record =
    model === null
      ? null
      : pricedRecord(model, {
          uncachedInputTokens: Math.max(0, input - cached - cacheCreation),
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: usage.reasoningTokens ?? 0,
        });
  const other = usage.otherUsage;
  const otherRecordModel = otherModel ?? model;
  const otherCached =
    other === undefined || input === 0 ? 0 : Math.round((other.inputTokens * cached) / input);
  const otherCacheCreation =
    other === undefined || input === 0
      ? 0
      : Math.round((other.inputTokens * cacheCreation) / input);
  return {
    tokens: input + output,
    record,
    otherTokens: other === undefined ? null : other.inputTokens + other.outputTokens,
    otherRecord:
      other === undefined || otherRecordModel === null
        ? null
        : pricedRecord(otherRecordModel, {
            uncachedInputTokens: Math.max(0, other.inputTokens - otherCached - otherCacheCreation),
            cachedInputTokens: otherCached,
            cacheCreationTokens: otherCacheCreation,
            outputTokens: other.outputTokens,
            reasoningTokens: 0,
          }),
  };
}

/**
 * The main agent's tokens and priceable records for one orchestration run, kept apart from
 * `otherUsage`, which takes the run's most used native subagent model.
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
    if (Option.isNone(decoded)) continue;
    const used = turnUsage(decoded.value, turn.model, subagentModel?.model ?? null);
    if (used === null) continue;
    tokens = sum(tokens, used.tokens);
    if (used.record !== null) records.push(used.record);
    if (used.otherTokens === null) continue;
    otherTokens = sum(otherTokens, used.otherTokens);
    if (used.otherRecord !== null) otherRecords.push(used.otherRecord);
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
