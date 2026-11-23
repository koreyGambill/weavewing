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

  // What a client before bookmarks knew as a follow-up.
  const legacyFollowUp = sql`f.passage_key = '' AND f.role = 'user' AND f.todo = 1`;

  const list = Effect.fn("MessageFollowUpService.list")(function* (
    input: MessageFollowUpListInput,
  ) {
    const scope =
      input.threadId !== undefined
        ? sql`f.thread_id = ${input.threadId}`
        : input.bookmarks
          ? sql`1 = 1`
          : sql`f.done_at IS NULL`;
    return yield* select(input.bookmarks ? scope : sql`${scope} AND ${legacyFollowUp}`);
  }, Effect.mapError(storageError));

  const notFound = (input: MessageFollowUpUpdateInput) =>
    new MessageFollowUpError({
      code: "not_found",
      message:
        input.action === "flag"
          ? `Message ${input.messageId} cannot be bookmarked in thread ${input.threadId}.`
          : `Message ${input.messageId} has no such bookmark.`,
    });

  const update = Effect.fn("MessageFollowUpService.update")(
    function* (input: MessageFollowUpUpdateInput) {
      const legacy =
        input.bookmarkId === undefined && input.anchor === undefined && input.todo === undefined;
      const key =
        input.bookmarkId !== undefined
          ? sql`f.thread_id = ${input.threadId} AND f.bookmark_id = ${input.bookmarkId}`
          : sql`f.thread_id = ${input.threadId} AND f.message_id = ${input.messageId}
              AND ${legacy ? legacyFollowUp : sql`f.passage_key = ''`}`;
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
            AND role IN ${legacy ? sql`('user')` : sql`('user', 'assistant')`}`;
          if (message === undefined) return yield* notFound(input);
          const passageKey =
            anchor === undefined ? "" : `${anchor.start}:${anchor.end}:${anchor.text}`;
          const id = yield* random.uuidV4();
          // One statement, so concurrent identical requests converge on one row. A legacy flag
          // also makes an existing plain whole-message bookmark a to-do.
          const [row] = yield* sql<{ readonly bookmark_id: string }>`INSERT INTO message_bookmarks
            (bookmark_id, thread_id, message_id, passage_key, role, excerpt, anchor_json, todo, flagged_at)
          VALUES (${id}, ${input.threadId}, ${input.messageId}, ${passageKey}, ${message.role},
            ${followUpExcerpt(anchor?.text ?? message.text ?? "")},
            ${anchor === undefined ? null : yield* encodeAnchor(anchor)},
            ${input.todo === false ? 0 : 1}, ${now})
          ON CONFLICT (thread_id, message_id, passage_key)
            DO UPDATE SET todo = ${legacy ? sql`1` : sql`todo`}
          RETURNING bookmark_id`;
          return row === undefined
            ? null
            : yield* selectOne(sql`f.bookmark_id = ${row.bookmark_id}`);
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
          const [row] = yield* sql<{
            readonly bookmark_id: string;
          }>`UPDATE message_bookmarks AS f SET ${change} WHERE ${key} ${onlyTodo} RETURNING bookmark_id`;
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
