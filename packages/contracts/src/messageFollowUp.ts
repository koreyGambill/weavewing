import * as Schema from "effect/Schema";
import { SideChatAnchor } from "./assistantCitations.ts";
import { IsoDateTime, MessageId, ThreadId } from "./baseSchemas.ts";

export const MESSAGE_FOLLOW_UP_EXCERPT_MAX_LENGTH = 200;

/**
 * A bookmark: a whole message, or a passage of one, the user marked to come back to. A to-do
 * bookmark also has an open or done state. Personal: never shown to agents. Servers without the
 * `messageBookmarks` capability send only whole user message to-dos, without `id`, `role`,
 * `anchor`, `todo` or `messageCreatedAt`.
 */
export const MessageFollowUp = Schema.Struct({
  id: Schema.optional(Schema.String),
  threadId: ThreadId,
  threadTitle: Schema.String,
  messageId: MessageId,
  /** Absent means a user message. */
  role: Schema.optional(Schema.Literals(["user", "assistant"])),
  /** Absent means the whole message. */
  anchor: Schema.optional(SideChatAnchor),
  messageCreatedAt: Schema.optional(IsoDateTime),
  /** Absent means a to-do, as every follow-up was. */
  todo: Schema.optional(Schema.Boolean),
  excerpt: Schema.String,
  flaggedAt: IsoDateTime,
  /** Always null for a bookmark that is not a to-do. */
  doneAt: Schema.NullOr(IsoDateTime),
});
export type MessageFollowUp = typeof MessageFollowUp.Type;

/**
 * With a thread, all its bookmarks. Without one, every bookmark across the environment when `all`
 * is set, else only open to-dos, as clients before bookmarks expect.
 */
export const MessageFollowUpListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  all: Schema.optional(Schema.Boolean),
});
export type MessageFollowUpListInput = typeof MessageFollowUpListInput.Type;

export const MessageFollowUpUpdateInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  action: Schema.Literals(["flag", "unflag", "done", "reopen", "todo", "untodo"]),
  /** With `flag`, whether the new bookmark is a to-do. Absent means a to-do, as follow-ups were. */
  todo: Schema.optional(Schema.Boolean),
  /** Targets one bookmark; absent targets the message's whole-message bookmark. */
  bookmarkId: Schema.optional(Schema.String),
  /** With `flag`, bookmarks this passage of the message instead of all of it. */
  anchor: Schema.optional(SideChatAnchor),
});
export type MessageFollowUpUpdateInput = typeof MessageFollowUpUpdateInput.Type;

export class MessageFollowUpError extends Schema.TaggedError<MessageFollowUpError>()(
  "MessageFollowUpError",
  {
    code: Schema.Literals(["not_found", "storage"]),
    message: Schema.String,
  },
) {}
