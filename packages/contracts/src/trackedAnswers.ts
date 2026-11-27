import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TrackedAskId = Schema.String.check(
  Schema.isPattern(/^A[1-9]\d*$/),
  Schema.isMaxLength(32),
);
export const TrackedQuestion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\r\n]+$/),
);
export const TrackedAnswerText = Schema.String.check(
  Schema.makeFilter((text) => text.trim().length > 0),
  Schema.isMaxLength(4000),
);
export const TrackedAnswerMore = Schema.String.check(Schema.isMaxLength(2000));

export const TrackedAskAbout = Schema.Struct({
  kind: Schema.Literals(["question", "qa", "task"]),
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  ref: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
});

export const TrackedAskContext = Schema.Struct({
  question: TrackedQuestion,
  about: Schema.optional(TrackedAskAbout),
  ref: Schema.optional(TrackedAskId),
});

export const TrackedAnswer = Schema.Struct({
  n: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  text: TrackedAnswerText,
  more: Schema.optional(TrackedAnswerMore),
  answeredAt: IsoDateTime,
  runId: Schema.NullOr(RunId),
});
export type TrackedAnswer = typeof TrackedAnswer.Type;

export const TrackedAsk = Schema.Struct({
  id: TrackedAskId,
  question: TrackedQuestion,
  askedInMessageId: MessageId,
  about: Schema.optional(TrackedAskAbout),
  state: Schema.Literals(["queued", "owed", "answered", "closed", "withdrawn"]),
  createdAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  answers: Schema.Array(TrackedAnswer),
  followUps: Schema.Array(Schema.Struct({ messageId: MessageId, at: IsoDateTime })),
  userChangedAt: Schema.optional(IsoDateTime),
  withdrawnBecause: Schema.optional(Schema.Literals(["user", "rollback"])),
});
export type TrackedAsk = typeof TrackedAsk.Type;

export function trackedQuestionLabel(text: string, about?: TrackedAsk["about"]) {
  const firstQuestion = text.slice(0, 600).match(/(?:^|[.!]\s+|[\r\n])([^.!?\r\n]+\?)/)?.[1];
  const firstLine = text.split(/\r?\n/).find((line) => line.trim());
  const label = (
    firstQuestion ??
    firstLine ??
    (about ? `Follow-up on ${about.ref}` : "Your message")
  )
    .trim()
    .replace(/\s+/g, " ");
  if (label.length <= 200) return label;
  const prefix = label.slice(0, 199).replace(/[\uD800-\uDBFF]$/, "");
  const lastSpace = prefix.lastIndexOf(" ");
  return `${lastSpace > 0 ? prefix.slice(0, lastSpace) : prefix}…`;
}

export const TrackedAnswerWaitingRow = Schema.Struct({
  ref: TrackedAskId,
  title: Schema.String,
  state: Schema.Literals(["queued", "owed", "answered"]),
});
export type TrackedAnswerWaitingRow = typeof TrackedAnswerWaitingRow.Type;

export const ThreadTrackMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type ThreadTrackMessageInput = typeof ThreadTrackMessageInput.Type;

export const ThreadUpdateAskInput = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    id: TrackedAskId,
    action: Schema.Literals(["close", "reopen", "withdraw", "restore"]),
  }),
  Schema.Struct({
    threadId: ThreadId,
    id: TrackedAskId,
    action: Schema.Literal("edit"),
    question: TrackedQuestion,
  }),
]);
export type ThreadUpdateAskInput = typeof ThreadUpdateAskInput.Type;

export const TrackedAnswersReadInput = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  Schema.Struct({
    all: Schema.Literal(true),
    cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  }),
]);
export type TrackedAnswersReadInput = typeof TrackedAnswersReadInput.Type;

export const TrackedAnswersPage = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      threadTitle: Schema.String,
      archived: Schema.Boolean,
      ask: TrackedAsk,
    }),
  ),
  cursor: Schema.optional(Schema.String),
});
export type TrackedAnswersPage = typeof TrackedAnswersPage.Type;
