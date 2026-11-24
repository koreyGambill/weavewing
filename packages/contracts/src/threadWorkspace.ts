import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ArtifactQuestion, ArtifactAnswer } from "./artifactQuestions.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const TicketData = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  stage: TrimmedNonEmptyString,
  url: Schema.String,
  terminal: Schema.optional(Schema.Boolean),
  workflow: Schema.optional(
    Schema.Array(
      Schema.Struct({
        stage: TrimmedNonEmptyString,
        done: Schema.Boolean,
        evidence: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type TicketData = typeof TicketData.Type;
export const ListLink = Schema.Struct({
  type: Schema.Literals(["ticket", "thread", "pr", "artifact", "url"]),
  target: TrimmedNonEmptyString,
});
export const ListLinkState = Schema.Struct({
  ...ListLink.fields,
  state: Schema.Literals(["open", "closed", "needs_review", "unknown"]),
  label: Schema.String,
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});
export const LIST_MAX_DEPTH = 3;
export const ListItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString.check(Schema.isPattern(/^[^\r\n]+$/)),
  state: Schema.Literals(["open", "done", "dropped", "handed_off"]),
  owner: Schema.Literals(["agent", "you"]),
  createdAt: IsoDateTime,
  doneAt: Schema.NullOr(IsoDateTime),
  details: Schema.String,
  parentId: Schema.NullOr(TrimmedNonEmptyString).annotate({
    description:
      "Parent item ID, or null for a root. Three levels: root, child, grandchild. No cycles.",
  }),
  links: Schema.Array(ListLink),
  linkStates: Schema.optional(Schema.Array(ListLinkState)),
});
export type ListItem = typeof ListItem.Type;
export const ThreadArtifactVersion = Schema.Struct({
  questions: Schema.Array(ArtifactQuestion),
  answers: Schema.Record(Schema.String, ArtifactAnswer),
  version: Revision,
  title: TrimmedNonEmptyString,
  format: Schema.Literals(["markdown", "html"]),
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadArtifactVersion = typeof ThreadArtifactVersion.Type;
export const ThreadArtifact = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  format: ThreadArtifactVersion.fields.format,
  versions: Schema.Array(ThreadArtifactVersion),
});
export type ThreadArtifact = typeof ThreadArtifact.Type;
export const ThreadArtifactMetadata = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  format: ThreadArtifactVersion.fields.format,
  version: Revision,
  createdAt: IsoDateTime,
  unansweredQuestions: Revision,
});
/** Deferred questions stay visible but no longer count as waiting on the user. */
export const ThreadQuestionState = Schema.Literals([
  "open",
  "deferred",
  "answered",
  "withdrawn",
  "replaced",
]);
export type ThreadQuestionState = typeof ThreadQuestionState.Type;
/** A question an agent raised without stopping its turn. `id` is server-assigned: Q1, Q2, ... */
export const ThreadQuestion = Schema.Struct({
  ...ArtifactQuestion.fields,
  state: ThreadQuestionState,
  createdAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  /** A draft while `submittedAt` is null; for an agent-recorded answer, what the agent understood. */
  answer: Schema.NullOr(ArtifactAnswer),
  answeredBy: Schema.NullOr(Schema.Literals(["user", "agent"])),
  replacedBy: Schema.NullOr(TrimmedNonEmptyString),
  /** When the user last deferred, withdrew or reopened it; cleared once the agent changes it. */
  userChangedAt: Schema.optional(IsoDateTime),
});
export type ThreadQuestion = typeof ThreadQuestion.Type;
export const ThreadWorkspace = Schema.Struct({
  threadId: ThreadId,
  revision: Revision,
  items: Schema.Array(ListItem),
  artifacts: Schema.Array(ThreadArtifact),
  questions: Schema.Array(ThreadQuestion).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  summaryNotes: Schema.String,
  childPreamble: Schema.String,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadWorkspace = typeof ThreadWorkspace.Type;
export const ThreadWorkspaceGetInput = Schema.Struct({ threadId: ThreadId });
export type ThreadWorkspaceGetInput = typeof ThreadWorkspaceGetInput.Type;
export const ListItemChange = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  text: Schema.optional(ListItem.fields.text),
  state: Schema.optional(ListItem.fields.state),
  owner: Schema.optional(ListItem.fields.owner),
  details: Schema.optional(Schema.String),
  parentId: Schema.optional(ListItem.fields.parentId),
  links: Schema.optional(ListItem.fields.links),
});
export const ThreadListUpdateInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Revision,
  changes: Schema.Array(ListItemChange),
  order: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  summaryNotes: Schema.optional(Schema.String),
  childPreamble: Schema.optional(Schema.String),
});
export type ThreadListUpdateInput = typeof ThreadListUpdateInput.Type;
export const ThreadListRewriteInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Revision,
  items: Schema.Array(ListItemChange),
});
export type ThreadListRewriteInput = typeof ThreadListRewriteInput.Type;
export const ThreadListReadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  allThreads: Schema.optional(Schema.Boolean),
  all: Schema.optional(Schema.Boolean),
});
export type ThreadListReadInput = typeof ThreadListReadInput.Type;
export const ThreadListEntry = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  revision: Revision,
  items: Schema.Array(ListItem),
  summaryNotes: Schema.String,
  childPreamble: Schema.String,
});
export type ThreadListEntry = typeof ThreadListEntry.Type;
export const ThreadArtifactWriteInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Revision,
  id: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  format: ThreadArtifactVersion.fields.format,
  content: Schema.String,
});
export type ThreadArtifactWriteInput = typeof ThreadArtifactWriteInput.Type;
export const ThreadArtifactReadInput = Schema.Struct({
  threadId: ThreadId,
  id: TrimmedNonEmptyString,
  version: Schema.optional(Revision),
});
export type ThreadArtifactReadInput = typeof ThreadArtifactReadInput.Type;
export class ThreadWorkspaceError extends Schema.TaggedError<ThreadWorkspaceError>()(
  "ThreadWorkspaceError",
  {
    code: Schema.Literals(["not_found", "invalid", "conflict", "storage", "thread"]),
    message: Schema.String,
    currentRevision: Schema.optional(Revision),
    operation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ThreadArtifactAnswerInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Revision,
  id: TrimmedNonEmptyString,
  version: Revision,
  answers: Schema.Record(Schema.String, ArtifactAnswer),
});
export type ThreadArtifactAnswerInput = typeof ThreadArtifactAnswerInput.Type;
export const ThreadArtifactSubmitInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Revision,
  id: TrimmedNonEmptyString,
  version: Revision,
  questionIds: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadArtifactSubmitInput = typeof ThreadArtifactSubmitInput.Type;

export const ThreadQuestionAskInput = Schema.Struct({
  threadId: ThreadId,
  questions: Schema.Array(
    Schema.Struct({
      prompt: ArtifactQuestion.fields.prompt,
      details: ArtifactQuestion.fields.details,
      options: Schema.optional(
        Schema.Array(
          Schema.Struct({
            id: TrimmedNonEmptyString,
            label: TrimmedNonEmptyString,
            description: Schema.optional(Schema.String),
          }),
        ),
      ),
      recommendedOptionIds: Schema.optional(ArtifactQuestion.fields.recommendedOptionIds),
      multiSelect: Schema.optional(ArtifactQuestion.fields.multiSelect),
      replaces: Schema.optional(TrimmedNonEmptyString),
    }),
  ).check(Schema.isMinLength(1)),
});
export type ThreadQuestionAskInput = typeof ThreadQuestionAskInput.Type;
export const ThreadQuestionUpdateInput = Schema.Struct({
  threadId: ThreadId,
  id: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "deferred", "answered", "withdrawn"]),
  answer: Schema.optional(
    Schema.Struct({
      chosenOptionIds: Schema.optional(ArtifactAnswer.fields.chosenOptionIds),
      notes: Schema.optional(Schema.String),
    }),
  ),
});
export type ThreadQuestionUpdateInput = typeof ThreadQuestionUpdateInput.Type;
export const ThreadQuestionDraftInput = Schema.Struct({
  threadId: ThreadId,
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({ chosenOptionIds: ArtifactAnswer.fields.chosenOptionIds, notes: Schema.String }),
  ),
});
export type ThreadQuestionDraftInput = typeof ThreadQuestionDraftInput.Type;
export const ThreadQuestionSubmitInput = Schema.Struct({
  threadId: ThreadId,
  ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type ThreadQuestionSubmitInput = typeof ThreadQuestionSubmitInput.Type;
/** The `artifactId` of an answer record that answers a thread question rather than an artifact. */
export const THREAD_QUESTIONS_ARTIFACT_ID = "thread-questions";

/** Linked work stays handed off until its ticket closes or its lane is ready for review. */
export const listItemNeedsHandoff = (item: Pick<ListItem, "linkStates">) =>
  item.linkStates?.some(
    (link) =>
      (link.type === "ticket" && link.state !== "closed") ||
      (link.type === "thread" && link.state !== "needs_review"),
  ) ?? false;
