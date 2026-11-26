import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The refusal when an agent records a user's outcome with no user message in its turn. */
export const NEEDS_USER_MESSAGE = "Only the user's message in this turn can settle this.";

/**
 * The user-authored input message of the thread's current run, as the per-turn waiting line reads
 * it, or null. Agents may record the user's outcome of a waiting item only from this message.
 */
export const currentUserMessage = Effect.fnUntraced(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const [message] = yield* sql<{ readonly message_id: string }>`WITH run AS (
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status IN ('starting', 'running', 'waiting')
        ORDER BY ordinal DESC LIMIT 1),
      input(message_id) AS (
        SELECT json_extract(payload_json, '$.userMessageId') FROM run
        UNION SELECT i.value FROM run, json_each(run.payload_json, '$.inputMessageIds') i)
      SELECT m.message_id FROM orchestration_v2_projection_messages m
      WHERE m.thread_id = ${threadId} AND m.message_id IN (SELECT message_id FROM input)
        AND m.role = 'user'
        AND json_extract(m.payload_json, '$.createdBy') = 'user'
        AND coalesce(json_extract(m.payload_json, '$.origin.kind'), 'user') = 'user'
        AND json_extract(m.payload_json, '$.scheduledTaskId') IS NULL
        AND json_extract(m.payload_json, '$.senderThreadId') IS NULL
        AND json_extract(m.payload_json, '$.linkedSender') IS NULL
        AND json_extract(m.payload_json, '$.delegatedCompletion') IS NULL
        AND json_extract(m.payload_json, '$.context.guest') IS NULL
      ORDER BY m.created_at DESC LIMIT 1`;
  return (message?.message_id ?? null) as MessageId | null;
});
