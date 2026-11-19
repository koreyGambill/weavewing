import {
  THREAD_TIMELINE_RUN_LIMIT,
  THREAD_USER_TURN_LIMIT,
  ThreadId,
  ThreadInsightsError,
  type OrchestrationV2RunStatus,
  type ThreadTimeline as Timeline,
  type ThreadTimelineGetInput,
  type ThreadTimelineLane,
  type ThreadTimelineRun,
  type ThreadUserTurn,
  type ThreadUserTurns,
  type ThreadUserTurnsGetInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const isInsightsError = Schema.is(ThreadInsightsError);
const MAX_DEPTH = 32;

export class ThreadTimeline extends Context.Service<
  ThreadTimeline,
  {
    readonly get: (input: ThreadTimelineGetInput) => Effect.Effect<Timeline, ThreadInsightsError>;
    readonly userTurns: (
      input: ThreadUserTurnsGetInput,
    ) => Effect.Effect<ThreadUserTurns, ThreadInsightsError>;
  }
>()("t3/threadInsights/ThreadTimeline") {}

interface Row {
  readonly thread_id: string;
  readonly parent_id: string | null;
  readonly depth: number;
  readonly title: string;
  readonly side_chat: number | null;
  readonly creation_source: string | null;
  readonly ordinal: number | null;
  readonly status: OrchestrationV2RunStatus | null;
  readonly requested_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly model: string | null;
}

const relationOf = (row: Row): ThreadTimelineLane["relation"] =>
  row.depth === 0
    ? "self"
    : row.side_chat === 1
      ? "side-chat"
      : row.creation_source === "provider"
        ? "subagent"
        : "delegate";

const parseTime = (value: string | null) => (value === null ? Number.NaN : Date.parse(value));

const buildTimeline = (threadId: ThreadId, rows: ReadonlyArray<Row>): Timeline => {
  const threads = new Map<string, Row>();
  const started: Array<{ readonly row: Row; readonly startedAt: number; readonly end: number }> =
    [];
  const byModel = new Map<string, number>();
  let finishedMs = 0;
  let firstStartedAt: number | null = null;
  let lastCompletedAt: number | null = null;
  for (const row of rows) {
    if (!threads.has(row.thread_id)) threads.set(row.thread_id, row);
    const startedAt = parseTime(row.started_at);
    if (row.ordinal === null || row.status === null || Number.isNaN(startedAt)) continue;
    const completed = parseTime(row.completed_at);
    const end = Number.isNaN(completed) ? Number.NaN : Math.max(completed, startedAt);
    started.push({ row, startedAt, end });
    firstStartedAt = Math.min(firstStartedAt ?? startedAt, startedAt);
    if (Number.isNaN(end)) continue;
    lastCompletedAt = Math.max(lastCompletedAt ?? end, end);
    finishedMs += end - startedAt;
    byModel.set(row.model ?? "", (byModel.get(row.model ?? "") ?? 0) + end - startedAt);
  }
  started.sort((a, b) => a.startedAt - b.startedAt);
  const kept = started.slice(-THREAD_TIMELINE_RUN_LIMIT);

  const keptThreads = new Set<string>([threadId]);
  for (const { row } of kept) {
    let id: string | null = row.thread_id;
    while (id !== null && !keptThreads.has(id)) {
      keptThreads.add(id);
      id = threads.get(id)?.parent_id ?? null;
    }
  }
  const laneIndex = new Map<string, number>();
  const laneRows = [...threads.values()].filter((row) => keptThreads.has(row.thread_id));
  laneRows.forEach((row, index) => laneIndex.set(row.thread_id, index));
  const lanes: ThreadTimelineLane[] = laneRows.map((row) => ({
    threadId: ThreadId.make(row.thread_id),
    parent: row.parent_id === null ? null : (laneIndex.get(row.parent_id) ?? null),
    depth: row.depth,
    title: row.title,
    relation: relationOf(row),
  }));

  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const runs = kept.map(({ row, startedAt, end }): ThreadTimelineRun => {
    const model = row.model ?? "";
    let index = modelIndex.get(model);
    if (index === undefined) {
      index = models.push(model) - 1;
      modelIndex.set(model, index);
    }
    const requested = parseTime(row.requested_at);
    return {
      lane: laneIndex.get(row.thread_id) ?? 0,
      ordinal: row.ordinal ?? 0,
      status: row.status ?? "completed",
      model: index,
      startedAt,
      queuedMs: Number.isNaN(requested) ? 0 : Math.max(0, startedAt - requested),
      durationMs: Number.isNaN(end) ? null : end - startedAt,
    };
  });
  return {
    threadId,
    lanes,
    models,
    runs,
    totals: {
      runs: started.length,
      firstStartedAt,
      lastCompletedAt,
      finishedMs,
      finishedMsByModel: [...byModel]
        .map(([model, ms]) => ({ model, ms }))
        .toSorted((a, b) => b.ms - a.ms),
    },
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The conversation window's rule (ProjectionStore retainedWindowRows): rolled-back runs and
  // queued input that never started are not in the transcript.
  const shownInConversation = (alias: string) => {
    const item = sql.literal(alias);
    return sql`NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS run
      WHERE run.run_id = ${item}.run_id
        AND (run.status = 'rolled_back' OR (
          ${item}.type = 'user_message'
          AND json_extract(${item}.payload_json, '$.inputIntent') = 'queued_turn'
          AND (run.status = 'queued' OR (
            run.status = 'cancelled' AND json_extract(run.payload_json, '$.startedAt') IS NULL
          ))
        ))
    )`;
  };
  return ThreadTimeline.of({
    get: Effect.fn("ThreadTimeline.get")(
      function* ({ threadId }) {
        // The family shares the indexed root expression; JSON is read once there, then the walk keeps this subtree.
        const rows = yield* sql<Row>`
          WITH RECURSIVE family AS MATERIALIZED (
            SELECT thread_id, title,
              json_extract(payload_json, '$.lineage.parentThreadId') AS parent_id,
              json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
              json_extract(payload_json, '$.lineage.sideChat') AS side_chat,
              json_extract(payload_json, '$.creationSource') AS creation_source
            FROM orchestration_v2_projection_threads
            WHERE deleted_at IS NULL
              AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END = (
                SELECT json_extract(payload_json, '$.lineage.rootThreadId')
                FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
              )
          ),
          tree(thread_id, parent_id, depth) AS (
            SELECT thread_id, NULL, 0 FROM family WHERE thread_id = ${threadId}
            UNION
            SELECT f.thread_id, tree.thread_id, tree.depth + 1
            FROM family f JOIN tree ON f.parent_id = tree.thread_id
            WHERE tree.depth < ${MAX_DEPTH} AND (f.relationship = 'subagent' OR f.side_chat = 1)
          )
          SELECT tree.thread_id, tree.parent_id, tree.depth, family.title, family.side_chat,
            family.creation_source, r.ordinal, r.status, r.requested_at, r.completed_at,
            json_extract(r.payload_json, '$.startedAt') AS started_at,
            json_extract(r.payload_json, '$.modelSelection.model') AS model
          FROM tree JOIN family ON family.thread_id = tree.thread_id
          LEFT JOIN orchestration_v2_projection_runs r ON r.thread_id = tree.thread_id
          ORDER BY tree.depth`;
        if (!rows.length)
          return yield* new ThreadInsightsError({ message: "This thread is unavailable." });
        return buildTimeline(threadId, rows);
      },
      Effect.mapError((cause) =>
        isInsightsError(cause)
          ? cause
          : new ThreadInsightsError({ message: "Could not load the thread timeline.", cause }),
      ),
      NodeSqliteClient.readOnly,
    ),
    userTurns: Effect.fn("ThreadTimeline.userTurns")(
      function* ({ threadId, sourceRunId }) {
        if (sourceRunId !== undefined) {
          const [source] = yield* sql<{ readonly messageId: ThreadUserTurn["messageId"] | null }>`
            SELECT json_extract(payload_json, '$.userMessageId') AS "messageId"
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND run_id = ${sourceRunId}
          `;
          return { turns: [], ...(source?.messageId ? { sourceMessageId: source.messageId } : {}) };
        }
        // Mirrors deriveTimelineMinimapItems: messages without a creator or origin are the user's.
        // The reply is the last assistant text before the next user-role message, as on the client.
        const turns = yield* sql<ThreadUserTurn>`
          WITH own AS (
            SELECT ordinal, updated_at, payload_json FROM orchestration_v2_projection_turn_items AS item
              INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
            WHERE thread_id = ${threadId} AND type = 'user_message'
              AND COALESCE(json_extract(payload_json, '$.createdBy'), 'user') = 'user'
              AND CASE WHEN json_type(payload_json, '$.origin') IS NULL
                THEN json_type(payload_json, '$.linkedSender') IS NULL
                  AND json_type(payload_json, '$.scheduledTaskId') IS NULL
                ELSE json_extract(payload_json, '$.origin.kind') = 'user' END
              AND ${shownInConversation("item")}
            ORDER BY ordinal DESC LIMIT ${THREAD_USER_TURN_LIMIT}
          ),
          bounded AS (
            SELECT own.*, COALESCE((
              SELECT next.ordinal FROM orchestration_v2_projection_turn_items AS next
                INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
              WHERE next.thread_id = ${threadId} AND next.type = 'user_message'
                AND next.ordinal > own.ordinal AND ${shownInConversation("next")}
              ORDER BY next.ordinal LIMIT 1
            ), 9223372036854775807) AS next_ordinal FROM own
          )
          SELECT json_extract(payload_json, '$.messageId') AS "messageId",
            COALESCE(json_extract(payload_json, '$.startedAt'), updated_at) AS "createdAt",
            substr(COALESCE(json_extract(payload_json, '$.text'), ''), 1, 200) AS "text",
            (
              SELECT substr(json_extract(reply.payload_json, '$.text'), 1, 300)
              FROM orchestration_v2_projection_turn_items AS reply
                INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
              WHERE reply.thread_id = ${threadId}
                AND reply.ordinal > bounded.ordinal AND reply.ordinal < bounded.next_ordinal
                AND reply.type = 'assistant_message'
                AND reply.type NOT IN (
                  'command_execution', 'reasoning', 'file_change', 'file_search', 'web_search', 'dynamic_tool'
                )
                AND ${shownInConversation("reply")}
              ORDER BY reply.ordinal DESC LIMIT 1
            ) AS "replyText"
          FROM bounded ORDER BY ordinal`;
        return { turns };
      },
      Effect.mapError(
        (cause) =>
          new ThreadInsightsError({ message: "Could not load the thread's turns.", cause }),
      ),
      NodeSqliteClient.readOnly,
    ),
  });
});

export const layer = Layer.effect(ThreadTimeline, make);
