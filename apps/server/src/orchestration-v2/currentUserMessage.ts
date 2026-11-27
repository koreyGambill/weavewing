import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The refusal when an agent records a user's outcome with no user message in its turn. */
export const NEEDS_USER_MESSAGE = "Only the user's message in this turn can settle this.";

export interface CurrentUserMessageOptions {
  /**
   * Return the message only when it is the one qualifying user message since this instant, so an
   * outcome the agent records late is not tied to a later, unrelated message.
   */
  readonly soleSince?: string;
}

/**
 * The user-authored input message of the thread's current run, as the per-turn waiting line reads
 * it, or null. Agents may record the user's outcome of a waiting item only from this message.
 */
export const currentUserMessage = Effect.fnUntraced(function* (
  threadId: ThreadId,
  options: CurrentUserMessageOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const since = options.soleSince ?? null;
  const [row] = yield* sql<{
    readonly current_id: string | null;
    readonly since_count: number;
    readonly first_since: string | null;
  }>`WITH run AS (
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status IN ('starting', 'running', 'waiting')
        ORDER BY ordinal DESC LIMIT 1),
      input(message_id) AS (
        SELECT json_extract(payload_json, '$.userMessageId') FROM run
        UNION SELECT i.value FROM run, json_each(run.payload_json, '$.inputMessageIds') i),
      qualifying AS (
        SELECT m.message_id, m.created_at FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = ${threadId}
          AND m.role = 'user'
          AND json_extract(m.payload_json, '$.createdBy') = 'user'
          AND coalesce(json_extract(m.payload_json, '$.origin.kind'), 'user') = 'user'
          AND json_extract(m.payload_json, '$.scheduledTaskId') IS NULL
          AND json_extract(m.payload_json, '$.senderThreadId') IS NULL
          AND json_extract(m.payload_json, '$.linkedSender') IS NULL
          AND json_extract(m.payload_json, '$.delegatedCompletion') IS NULL
          AND json_extract(m.payload_json, '$.context.guest') IS NULL),
      current AS (
        SELECT message_id FROM qualifying WHERE message_id IN (SELECT message_id FROM input)
        ORDER BY created_at DESC LIMIT 1),
      since AS (
        SELECT message_id FROM qualifying
        WHERE ${since} IS NOT NULL AND julianday(created_at) > julianday(${since})
        ORDER BY created_at LIMIT 2)
      SELECT (SELECT message_id FROM current) AS current_id,
        (SELECT count(*) FROM since) AS since_count,
        (SELECT message_id FROM since LIMIT 1) AS first_since`;
  const current = (row?.current_id ?? null) as MessageId | null;
  if (since === null || current === null) return current;
  return row?.since_count === 1 && row.first_since === current ? current : null;
});
