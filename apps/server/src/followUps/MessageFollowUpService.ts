import {
  MESSAGE_FOLLOW_UP_EXCERPT_MAX_LENGTH,
  MessageFollowUp,
  MessageFollowUpError,
  SideChatAnchor,
  type MessageFollowUpListInput,
  type MessageFollowUpUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { messageSearchText } from "../orchestration-v2/messageSearchIndex.ts";

/** Per-environment message bookmarks for the user. No MCP tool or provider context reads this. */
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

const FollowUpRow = Schema.Struct({
  ...MessageFollowUp.fields,
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  anchor: Schema.NullOr(Schema.fromJsonString(SideChatAnchor)),
  messageCreatedAt: Schema.NullOr(MessageFollowUp.fields.flaggedAt),
  todo: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(FollowUpRow));
const encodeAnchor = Schema.encodeEffect(Schema.fromJsonString(SideChatAnchor));

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
  const random = yield* SecureRandom.SecureRandom;

  const select = (where: Statement.Fragment) =>
    sql`SELECT f.bookmark_id AS "id", f.thread_id AS "threadId", t.title AS "threadTitle",
      f.message_id AS "messageId", f.role, f.anchor_json AS "anchor",
      m.created_at AS "messageCreatedAt", f.todo, f.excerpt, f.flagged_at AS "flaggedAt",
      f.done_at AS "doneAt"
      FROM message_bookmarks f
      JOIN orchestration_v2_projection_threads t ON t.thread_id = f.thread_id
      LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = f.message_id
      WHERE t.deleted_at IS NULL AND ${where}
      ORDER BY f.flagged_at DESC, f.message_id, f.bookmark_id`.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) =>
        rows.map(({ anchor, messageCreatedAt, todo, ...row }): MessageFollowUp => ({
          ...row,
          todo: todo === 1,
          ...(anchor === null ? {} : { anchor }),
          ...(messageCreatedAt === null ? {} : { messageCreatedAt }),
        })),
      ),
    );

  const list = Effect.fn("MessageFollowUpService.list")(function* (
    input: MessageFollowUpListInput,
  ) {
    return yield* select(
      input.threadId !== undefined
        ? sql`f.thread_id = ${input.threadId}`
        : input.all === true
          ? sql`1 = 1`
          : sql`f.todo = 1 AND f.done_at IS NULL`,
    );
  }, Effect.mapError(storageError));

  const notFound = (input: MessageFollowUpUpdateInput) =>
    new MessageFollowUpError({
      code: "not_found",
      message:
        input.action === "flag"
          ? `Message ${input.messageId} is not a user or assistant message in thread ${input.threadId}.`
          : `Message ${input.messageId} has no such bookmark.`,
    });

  const update = Effect.fn("MessageFollowUpService.update")(
    function* (input: MessageFollowUpUpdateInput) {
      const key =
        input.bookmarkId === undefined
          ? sql`f.thread_id = ${input.threadId} AND f.message_id = ${input.messageId} AND f.anchor_json IS NULL`
          : sql`f.thread_id = ${input.threadId} AND f.bookmark_id = ${input.bookmarkId}`;
      const now = DateTime.formatIso(yield* DateTime.now);
      const selectOne = (where: Statement.Fragment) =>
        select(where).pipe(Effect.map(([item]) => item ?? null));
      switch (input.action) {
        case "flag": {
          const { anchor } = input;
          if (anchor !== undefined && anchor.messageId !== input.messageId) {
            return yield* notFound(input);
          }
          const [message] = yield* sql<{ readonly text: string | null; readonly role: string }>`
          SELECT ${messageSearchText(sql)} AS text, role FROM orchestration_v2_projection_messages messages
          WHERE message_id = ${input.messageId} AND thread_id = ${input.threadId}
            AND role IN ('user', 'assistant')`;
          if (message === undefined) return yield* notFound(input);
          const sameBookmark =
            anchor === undefined
              ? sql`f.anchor_json IS NULL`
              : sql`json_extract(f.anchor_json, '$.start') = ${anchor.start}
                  AND json_extract(f.anchor_json, '$.end') = ${anchor.end}`;
          const existing = yield* selectOne(
            sql`f.thread_id = ${input.threadId} AND f.message_id = ${input.messageId} AND ${sameBookmark}`,
          );
          if (existing !== null) return existing;
          const id = yield* random.uuidV4();
          yield* sql`INSERT INTO message_bookmarks
            (bookmark_id, thread_id, message_id, role, excerpt, anchor_json, todo, flagged_at)
          VALUES (${id}, ${input.threadId}, ${input.messageId}, ${message.role},
            ${followUpExcerpt(anchor?.text ?? message.text ?? "")},
            ${anchor === undefined ? null : yield* encodeAnchor(anchor)},
            ${input.todo === false ? 0 : 1}, ${now})`;
          return yield* selectOne(sql`f.bookmark_id = ${id}`);
        }
        case "unflag":
          yield* sql`DELETE FROM message_bookmarks AS f WHERE ${key}`;
          return null;
        case "done":
        case "reopen":
        case "todo":
        case "untodo": {
          // Only a to-do can be done; leaving to-do drops its done state.
          const change =
            input.action === "todo"
              ? sql`todo = 1`
              : input.action === "untodo"
                ? sql`todo = 0, done_at = NULL`
                : sql`done_at = ${input.action === "done" ? sql`coalesce(done_at, ${now})` : sql`NULL`}`;
          const onlyTodo =
            input.action === "done" || input.action === "reopen" ? sql`AND f.todo = 1` : sql``;
          const touched = yield* sql<{
            readonly bookmark_id: string;
          }>`UPDATE message_bookmarks AS f SET ${change} WHERE ${key} ${onlyTodo} RETURNING bookmark_id`;
          const [row] = touched;
          if (row === undefined) return yield* notFound(input);
          return yield* selectOne(sql`f.bookmark_id = ${row.bookmark_id}`);
        }
      }
    },
    Effect.catchTags({
      SqlError: (cause) => Effect.fail(storageError(cause)),
      SchemaError: (cause) => Effect.fail(storageError(cause)),
    }),
  );

  return MessageFollowUpService.of({ list, update });
});

export const layer = Layer.effect(MessageFollowUpService, make);
