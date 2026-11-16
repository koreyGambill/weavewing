import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { PullRequestRef } from "./pullRequest.ts";

/** `threadId` is the thread asking: its model writes the guide. The stored guide stays per PR head. */
export const PullRequestGenerateReviewGuideInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: Schema.optional(ThreadId),
});
export type PullRequestGenerateReviewGuideInput = typeof PullRequestGenerateReviewGuideInput.Type;

export const PullRequestReviewGuideAttention = Schema.Struct({
  kind: Schema.Literals(["tradeoff", "contract", "product", "risk", "accessibility"]),
  note: TrimmedNonEmptyString,
});
export type PullRequestReviewGuideAttention = typeof PullRequestReviewGuideAttention.Type;

export const PullRequestReviewGuideExcerpt = Schema.Struct({
  path: TrimmedNonEmptyString,
  side: Schema.Literals(["new", "old"]),
  start: PositiveInt,
  end: PositiveInt,
  caption: Schema.String,
});
export type PullRequestReviewGuideExcerpt = typeof PullRequestReviewGuideExcerpt.Type;

export const PullRequestReviewGuideNote = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
});
export type PullRequestReviewGuideNote = typeof PullRequestReviewGuideNote.Type;

export const PullRequestReviewGuideStop = Schema.Struct({
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  attention: Schema.NullOr(PullRequestReviewGuideAttention),
  excerpts: Schema.Array(PullRequestReviewGuideExcerpt),
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      note: Schema.optionalKey(Schema.String),
    }),
  ),
  notes: Schema.Array(PullRequestReviewGuideNote),
  questions: Schema.Array(TrimmedNonEmptyString),
});
export type PullRequestReviewGuideStop = typeof PullRequestReviewGuideStop.Type;

export const PullRequestReviewGuide = Schema.Struct({
  headSha: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  modelSelection: ModelSelection,
  stops: Schema.Array(PullRequestReviewGuideStop),
});
export type PullRequestReviewGuide = typeof PullRequestReviewGuide.Type;

export const PullRequestReviewGuideRun = Schema.Union([
  Schema.TaggedStruct("Running", {
    headSha: TrimmedNonEmptyString,
    startedAt: IsoDateTime,
  }),
  Schema.TaggedStruct("Failed", {
    headSha: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
    detail: TrimmedNonEmptyString,
  }),
]);
export type PullRequestReviewGuideRun = typeof PullRequestReviewGuideRun.Type;

export const PullRequestReviewGuideResult = Schema.Struct({
  guide: Schema.NullOr(PullRequestReviewGuide),
  run: Schema.NullOr(PullRequestReviewGuideRun),
  currentHeadSha: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestReviewGuideResult = typeof PullRequestReviewGuideResult.Type;
