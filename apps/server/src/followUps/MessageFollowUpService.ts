import {
  MESSAGE_FOLLOW_UP_EXCERPT_MAX_LENGTH,
  MessageFollowUp,
  MessageFollowUpError,
  type MessageFollowUpListInput,
  type MessageFollowUpUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { messageSearchText } from "../orchestration-v2/messageSearchIndex.ts";

/** Per-environment message flags for the user. No MCP tool or provider context reads this. */
export class MessageFollowUpService extends Context.Service<
  MessageFollowUpService,
  {
    readonly list: (
      input: MessageFollowUpListInput,
    ) => Effect.Effect<ReadonlyArray<MessageFollowUp>, MessageFollowUpError>;
    readonly update: (
      input: MessageFollowUpUpdateInput,
    ) => Effect.Effect<MessageFollowUp | null, MessageFollowUpError>;
  }
>()("t3/followUps/MessageFollowUpService") {}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(MessageFollowUp));

const followUpExcerpt = (text: string) => {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return "";
  return line.length > MESSAGE_FOLLOW_UP_EXCERPT_MAX_LENGTH
    ? `${line.slice(0, MESSAGE_FOLLOW_UP_EXCERPT_MAX_LENGTH - 1)}…`
    : line;
};

const storageError = (cause: { readonly message: string }) =>
  new MessageFollowUpError({ code: "storage", message: cause.message });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const select = (where: Statement.Fragment) =>
    sql`SELECT f.thread_id AS "threadId", t.title AS "threadTitle", f.message_id AS "messageId",
      f.role, f.excerpt, f.flagged_at AS "flaggedAt", f.done_at AS "doneAt"
      FROM message_follow_ups f
      JOIN orchestration_v2_projection_threads t ON t.thread_id = f.thread_id
      WHERE t.deleted_at IS NULL AND ${where}
      ORDER BY f.flagged_at DESC, f.message_id`.pipe(Effect.flatMap(decodeRows));

  const list = Effect.fn("MessageFollowUpService.list")(function* (
    input: MessageFollowUpListInput,
  ) {
    return yield* select(
      input.threadId === undefined ? sql`f.done_at IS NULL` : sql`f.thread_id = ${input.threadId}`,
    );
  }, Effect.mapError(storageError));

  const notFound = (input: MessageFollowUpUpdateInput) =>
    new MessageFollowUpError({
      code: "not_found",
      message:
        input.action === "flag"
          ? `Message ${input.messageId} is not in thread ${input.threadId}.`
          : `Message ${input.messageId} is not flagged.`,
    });

  const update = Effect.fn("MessageFollowUpService.update")(
    function* (input: MessageFollowUpUpdateInput) {
      const key = sql`thread_id = ${input.threadId} AND message_id = ${input.messageId}`;
      const now = DateTime.formatIso(yield* DateTime.now);
      switch (input.action) {
        case "flag": {
          const [message] = yield* sql<{ readonly role: string; readonly text: string | null }>`
          SELECT role, ${messageSearchText(sql)} AS text FROM orchestration_v2_projection_messages messages
          WHERE message_id = ${input.messageId} AND thread_id = ${input.threadId}`;
          if (message === undefined || (message.role !== "user" && message.role !== "assistant"))
            return yield* notFound(input);
          yield* sql`INSERT INTO message_follow_ups (thread_id, message_id, role, excerpt, flagged_at)
          VALUES (${input.threadId}, ${input.messageId}, ${message.role}, ${followUpExcerpt(message.text ?? "")}, ${now})
          ON CONFLICT (thread_id, message_id) DO NOTHING`;
          break;
        }
        case "unflag":
          yield* sql`DELETE FROM message_follow_ups WHERE ${key}`;
          return null;
        case "done":
        case "reopen": {
          const doneAt = input.action === "done" ? sql`coalesce(done_at, ${now})` : sql`NULL`;
          const touched =
            yield* sql`UPDATE message_follow_ups SET done_at = ${doneAt} WHERE ${key} RETURNING message_id`;
          if (touched.length === 0) return yield* notFound(input);
          break;
        }
      }
      const [item] = yield* select(
        sql`f.thread_id = ${input.threadId} AND f.message_id = ${input.messageId}`,
      );
      return item ?? null;
    },
    Effect.catchTags({
      SqlError: (cause) => Effect.fail(storageError(cause)),
      SchemaError: (cause) => Effect.fail(storageError(cause)),
    }),
  );

  return MessageFollowUpService.of({ list, update });
});

export const layer = Layer.effect(MessageFollowUpService, make);
