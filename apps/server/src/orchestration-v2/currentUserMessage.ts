import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  // The stored form, so the bound compares as text and the thread's created_at index can seek it.
  const anchor = options.soleSince === undefined ? Option.none() : DateTime.make(options.soleSince);
  const since = Option.isSome(anchor) ? DateTime.formatIso(anchor.value) : null;
  const qualifying = sql`m.role = 'user'
    AND json_extract(m.payload_json, '$.createdBy') = 'user'
    AND coalesce(json_extract(m.payload_json, '$.origin.kind'), 'user') = 'user'
    AND json_extract(m.payload_json, '$.scheduledTaskId') IS NULL
    AND json_extract(m.payload_json, '$.senderThreadId') IS NULL
    AND json_extract(m.payload_json, '$.linkedSender') IS NULL
    AND json_extract(m.payload_json, '$.delegatedCompletion') IS NULL
    AND json_extract(m.payload_json, '$.context.guest') IS NULL`;
  const [row] = yield* sql<{
    readonly current_id: string | null;
    readonly since_count: number;
    readonly newest_since: string | null;
  }>`WITH run AS (
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status IN ('starting', 'running', 'waiting')
        ORDER BY ordinal DESC LIMIT 1),
      input(message_id) AS (
        SELECT json_extract(payload_json, '$.userMessageId') FROM run
        UNION SELECT i.value FROM run, json_each(run.payload_json, '$.inputMessageIds') i),
      current AS (
        SELECT m.message_id FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = ${threadId} AND m.message_id IN (SELECT message_id FROM input)
          AND ${qualifying}
        ORDER BY m.created_at DESC LIMIT 1),
      since AS (
        SELECT m.message_id FROM orchestration_v2_projection_messages m
        -- With no bound the caller reads only the current message, so this matches nothing.
        WHERE m.thread_id = ${threadId} AND m.created_at >= ${since ?? "9999"} AND ${qualifying}
        ORDER BY m.created_at DESC LIMIT 2)
      SELECT (SELECT message_id FROM current) AS current_id,
        (SELECT count(*) FROM since) AS since_count,
        (SELECT message_id FROM since LIMIT 1) AS newest_since`;
  const current = (row?.current_id ?? null) as MessageId | null;
  if (options.soleSince === undefined || current === null) return current;
  if (since === null) return null;
  return row?.since_count === 1 && row.newest_since === current ? current : null;
});
