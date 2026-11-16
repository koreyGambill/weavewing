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
export const ThreadWorkspace = Schema.Struct({
  threadId: ThreadId,
  revision: Revision,
  items: Schema.Array(ListItem),
  artifacts: Schema.Array(ThreadArtifact),
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

/** Linked work stays handed off until its ticket closes or its lane is ready for review. */
export const listItemNeedsHandoff = (item: Pick<ListItem, "linkStates">) =>
  item.linkStates?.some(
    (link) =>
      (link.type === "ticket" && link.state !== "closed") ||
      (link.type === "thread" && link.state !== "needs_review"),
  ) ?? false;
