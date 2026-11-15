import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, ThreadId } from "./baseSchemas.ts";

export const MESSAGE_FOLLOW_UP_EXCERPT_MAX_LENGTH = 200;

/** A message the user sent and flagged to come back to. Personal: never shown to agents. */
export const MessageFollowUp = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  messageId: MessageId,
  excerpt: Schema.String,
  flaggedAt: IsoDateTime,
  doneAt: Schema.NullOr(IsoDateTime),
});
export type MessageFollowUp = typeof MessageFollowUp.Type;

/** With a thread, its open and done follow-ups; without one, open ones across the environment. */
export const MessageFollowUpListInput = Schema.Struct({ threadId: Schema.optional(ThreadId) });
export type MessageFollowUpListInput = typeof MessageFollowUpListInput.Type;

export const MessageFollowUpUpdateInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  action: Schema.Literals(["flag", "unflag", "done", "reopen"]),
});
export type MessageFollowUpUpdateInput = typeof MessageFollowUpUpdateInput.Type;

export class MessageFollowUpError extends Schema.TaggedError<MessageFollowUpError>()(
  "MessageFollowUpError",
  {
    code: Schema.Literals(["not_found", "storage"]),
    message: Schema.String,
  },
) {}
