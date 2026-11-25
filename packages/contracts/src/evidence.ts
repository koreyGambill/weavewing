import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const Text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const EVIDENCE_LIST_PAGE_SIZE = 20;
export const EVIDENCE_RECORD_MAX_BYTES = 64 * 1024;

export const EvidenceSlug = Text(120).check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/));

export const EvidenceQaState = Schema.Literals(["pending", "confirmed", "failed", "waived"]);
export type EvidenceQaState = typeof EvidenceQaState.Type;

const Reason = Text(300);

export const EvidenceVerification = Schema.Struct({
  label: Text(80),
  result: Schema.Literals(["pass", "fail", "skipped"]),
  runId: Schema.optional(Text(200)),
  detail: Schema.optional(Text(500)),
  /** Records from before reasons were required may lack one. */
  reason: Schema.optional(
    Reason.annotate({ description: "Required when result is skipped: why, in one line." }),
  ),
});
export type EvidenceVerification = typeof EvidenceVerification.Type;

/** The review as an agent reports it. */
const EvidenceReviewInput = Schema.Struct({
  verdict: Schema.Literals(["approved", "changes_requested", "waived"]),
  by: Schema.optional(Text(120)),
  summary: Schema.optional(Text(2000)),
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Links the reviewer thread: a review-role delegate of the lead.",
    }),
  ),
  reason: Schema.optional(
    Reason.annotate({ description: "Required when verdict is waived: why, in one line." }),
  ),
});

export const EvidenceChange = Schema.Struct({
  id: EvidenceSlug,
  ask: Text(2000),
  askRef: Schema.optional(Schema.Struct({ threadId: ThreadId, messageId: Text(200) })),
  ticket: Schema.optional(Schema.Struct({ key: Text(80), url: Schema.optional(Text(2048)) })),
  branch: Schema.optional(Text(200)),
  commits: Schema.Array(Text(64).check(Schema.isPattern(/^[0-9a-f]{4,64}$/))).check(
    Schema.isMaxLength(50),
  ),
  summary: Text(2000),
  review: Schema.Struct({
    ...EvidenceReviewInput.fields,
    /**
     * Whether a reviewer is known to have stated this verdict. The server writes only `unverified`;
     * the other values only let older development records decode, and clients show them as
     * unverified too.
     */
    check: Schema.optional(Schema.Literals(["verified", "verdict_unconfirmed", "unverified"])),
  }),
  /** Absolute server paths under the evidence root; clients mint asset URLs when a change opens. */
  captures: Schema.Array(Schema.Struct({ path: Text(1024), caption: Text(300) })).check(
    Schema.isMaxLength(12),
  ),
  gaps: Schema.Array(Text(300)).check(Schema.isMaxLength(10)),
  evidenceDir: Schema.optional(Text(1024)),
});
export type EvidenceChange = typeof EvidenceChange.Type;

/** The agent-written part of a landing, stored as one JSON document. */
export const EvidenceRecord = Schema.Struct({
  id: EvidenceSlug,
  title: Text(200),
  target: Schema.Struct({ branch: Text(200), sha: Text(64) }),
  verifications: Schema.Array(EvidenceVerification).check(Schema.isMaxLength(20)),
  changes: Schema.Array(EvidenceChange).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export type EvidenceRecord = typeof EvidenceRecord.Type;

const EvidenceVerificationInput = EvidenceVerification.check(
  Schema.makeFilter((verification: EvidenceVerification) =>
    verification.result !== "skipped" || verification.reason !== undefined
      ? true
      : `Verification "${verification.label}" is skipped; give a one-line reason.`,
  ),
);

const EvidenceChangeInputFields = Schema.Struct({
  ...EvidenceChange.fields,
  review: EvidenceReviewInput,
});

const EvidenceChangeInput = EvidenceChangeInputFields.check(
  Schema.makeFilter((change: typeof EvidenceChangeInputFields.Type) =>
    change.review.verdict !== "waived" || change.review.reason !== undefined
      ? true
      : `Change "${change.id}" waives review; give review.reason in one line.`,
  ),
);

/**
 * Recording again with the same id replaces the record and keeps QA. A waived
 * review or skipped check needs its reason here; stored records may predate that.
 */
export const EvidenceRecordInput = Schema.Struct({
  ...EvidenceRecord.fields,
  verifications: Schema.Array(EvidenceVerificationInput).check(Schema.isMaxLength(20)),
  changes: Schema.Array(EvidenceChangeInput).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  threadId: Schema.optional(ThreadId),
  landedAt: Schema.optional(IsoDateTime),
});
export type EvidenceRecordInput = typeof EvidenceRecordInput.Type;

export const EvidenceChangeQa = Schema.Struct({
  state: EvidenceQaState,
  note: Schema.String.check(Schema.isMaxLength(2000)),
  updatedAt: IsoDateTime,
});
export type EvidenceChangeQa = typeof EvidenceChangeQa.Type;

/**
 * What a review's `threadId` points at when the landing is read: a review delegate, another thread,
 * an archived thread, or one that is gone. Set on read only; it is never stored or accepted.
 */
export const EvidenceReviewThread = Schema.Literals(["reviewer", "other", "archived", "missing"]);
export type EvidenceReviewThread = typeof EvidenceReviewThread.Type;

export const EvidenceLanding = Schema.Struct({
  ...EvidenceRecord.fields,
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  landedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  changes: Schema.Array(
    Schema.Struct({
      ...EvidenceChange.fields,
      review: Schema.Struct({
        ...EvidenceChange.fields.review.fields,
        thread: Schema.optional(EvidenceReviewThread),
      }),
      qa: EvidenceChangeQa,
    }),
  ),
});
export type EvidenceLanding = typeof EvidenceLanding.Type;

export const EvidenceQaTally = Schema.Struct({
  pending: NonNegativeInt,
  confirmed: NonNegativeInt,
  failed: NonNegativeInt,
  waived: NonNegativeInt,
});
export type EvidenceQaTally = typeof EvidenceQaTally.Type;

export const EvidenceLandingSummary = Schema.Struct({
  id: EvidenceSlug,
  title: EvidenceRecord.fields.title,
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  landedAt: IsoDateTime,
  target: EvidenceRecord.fields.target,
  verifications: Schema.Array(
    Schema.Struct({
      label: EvidenceVerification.fields.label,
      result: EvidenceVerification.fields.result,
      reason: EvidenceVerification.fields.reason,
    }),
  ),
  changeCount: NonNegativeInt,
  qa: EvidenceQaTally,
});
export type EvidenceLandingSummary = typeof EvidenceLandingSummary.Type;

const EvidenceCursor = Schema.Struct({ landedAt: IsoDateTime, id: EvidenceSlug });

export const EvidenceListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  /** Only landings with a pending or failed change. */
  needsQa: Schema.optional(Schema.Boolean),
  before: Schema.optional(EvidenceCursor),
});
export type EvidenceListInput = typeof EvidenceListInput.Type;

export const EvidenceListResult = Schema.Struct({
  items: Schema.Array(EvidenceLandingSummary),
  next: Schema.NullOr(EvidenceCursor),
});
export type EvidenceListResult = typeof EvidenceListResult.Type;

export const EvidenceGetInput = Schema.Struct({ landingId: EvidenceSlug });
export type EvidenceGetInput = typeof EvidenceGetInput.Type;

export const EvidenceSetQaInput = Schema.Struct({
  landingId: EvidenceSlug,
  changeId: EvidenceSlug,
  state: EvidenceQaState,
  note: Schema.optional(EvidenceChangeQa.fields.note),
});
export type EvidenceSetQaInput = typeof EvidenceSetQaInput.Type;

export const EvidenceCounts = Schema.Struct({ pending: NonNegativeInt, failed: NonNegativeInt });
export type EvidenceCounts = typeof EvidenceCounts.Type;

export const EvidenceCoverageInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type EvidenceCoverageInput = typeof EvidenceCoverageInput.Type;

/** A project whose target branch has merges since its first landing that no landing covers. */
export const EvidenceProjectCoverage = Schema.Struct({
  projectId: ProjectId,
  branch: Schema.String,
  head: Schema.String,
  /** The newest landing's thread, where "Ask lead" drafts when no thread is open. */
  leadThreadId: ThreadId,
  uncoveredCount: NonNegativeInt,
  /** Newest first, capped. */
  uncovered: Schema.Array(Schema.Struct({ sha: Schema.String, subject: Schema.String })),
});
export type EvidenceProjectCoverage = typeof EvidenceProjectCoverage.Type;

export const EvidenceRecordResult = Schema.Struct({
  landingId: EvidenceSlug,
  changes: Schema.Array(Schema.Struct({ id: EvidenceSlug, qa: EvidenceQaState })),
  /** Problems kept in the record, such as a capture that is missing. */
  warnings: Schema.Array(Schema.String),
});
export type EvidenceRecordResult = typeof EvidenceRecordResult.Type;

export class EvidenceError extends Schema.TaggedError<EvidenceError>()("EvidenceError", {
  code: Schema.Literals(["invalid", "not_found", "storage"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
