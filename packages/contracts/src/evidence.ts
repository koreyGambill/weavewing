import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const Text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const EVIDENCE_LIST_PAGE_SIZE = 20;
export const EVIDENCE_RECORD_MAX_BYTES = 64 * 1024;

export const EvidenceSlug = Text(120).check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/));

/**
 * `pending` waits on the user; `quiet` had nothing for the user to judge; `problem` is a fix the
 * agent owes; `waived` shows as "Dismissed".
 */
export const EvidenceQaState = Schema.Literals([
  "pending",
  "quiet",
  "confirmed",
  "problem",
  "waived",
]);
export type EvidenceQaState = typeof EvidenceQaState.Type;

/**
 * Why a recorded change asks for the user's QA. A change with none is recorded quietly. `legacy`
 * marks a change that was waiting on the user before reasons were kept, once it is answered.
 * `needs_you` is the agent's or the user's mark; `gaps` raised a card before agents marked changes.
 */
export const EvidenceQaRaiseReason = Schema.Literals([
  "legacy",
  "captures",
  "review_waived",
  "review_changes_requested",
  "check_failed",
  "check_skipped",
  "gaps",
  "needs_you",
]);
export type EvidenceQaRaiseReason = typeof EvidenceQaRaiseReason.Type;

/** Who set the QA state: the server when it recorded the change, the user, or an agent. */
export const EvidenceQaBy = Schema.Literals(["server", "user", "agent"]);
export type EvidenceQaBy = typeof EvidenceQaBy.Type;

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
  attention: Schema.optional(
    Schema.Literals(["needs_you", "note"]).annotate({
      description:
        "needs_you: the user must look at or decide something you could not, such as a visual change nobody has seen or the asked-for behavior never run; it raises a QA card. note (the default): routine gaps such as no device run or no live remote, kept in the thread's notes log with no card. Captures, a waived or changes-requested review and a failed or skipped check raise a card either way.",
    }),
  ),
  evidenceDir: Schema.optional(Text(1024)),
  /** Earlier changes the agent recorded as `problem` that this change fixes. */
  fixes: Schema.optional(
    Schema.Array(Schema.Struct({ landingId: EvidenceSlug, changeId: EvidenceSlug })).check(
      Schema.isMaxLength(20),
    ),
  ),
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
  by: Schema.optional(EvidenceQaBy),
  /** The thread's QA number, shown as QA<ref>; set once the change raises a card. */
  ref: Schema.optional(PositiveInt),
  /** Why the change asks for QA; absent on landings recorded before reasons were kept. */
  raised: Schema.optional(Schema.Array(EvidenceQaRaiseReason)),
  /** The user message that settled it, when an agent recorded the outcome from chat. */
  messageId: Schema.optional(MessageId),
  /** The user's message about this change, sent with Discuss, still awaiting the agent. */
  discussedMessageId: Schema.optional(MessageId),
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
  /** The top-level thread that shows this landing's QA: the lead, for a delegated child's landing. */
  qaThreadId: Schema.optional(ThreadId),
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
  quiet: NonNegativeInt,
  confirmed: NonNegativeInt,
  problem: NonNegativeInt,
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
  /**
   * With `notes`: the changes recorded without a card that list gaps, in record order. `title` is
   * the summary's first line, else the ask's.
   */
  notes: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: EvidenceSlug, title: Schema.String, gaps: EvidenceChange.fields.gaps }),
    ),
  ),
});
export type EvidenceLandingSummary = typeof EvidenceLandingSummary.Type;

const EvidenceCursor = Schema.Struct({ landedAt: IsoDateTime, id: EvidenceSlug });

export const EvidenceListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  /** Only landings with a pending or problem change. */
  needsQa: Schema.optional(Schema.Boolean),
  /** Only landings with a note, each listing its notes. */
  notes: Schema.optional(Schema.Boolean),
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

/** The user's QA: confirm, dismiss (stored as `waived`) or reopen. `problem` is the agent's to record. */
export const EvidenceSetQaInput = Schema.Struct({
  landingId: EvidenceSlug,
  changeId: EvidenceSlug,
  state: Schema.Literals(["pending", "confirmed", "waived"]),
  note: Schema.optional(EvidenceChangeQa.fields.note),
});
export type EvidenceSetQaInput = typeof EvidenceSetQaInput.Type;

const EvidenceAgentQaInputFields = Schema.Struct({
  landingId: EvidenceSlug,
  changeId: EvidenceSlug,
  state: Schema.Literals(["confirmed", "problem", "dismissed", "pending"]),
  note: Schema.optional(Text(2000)),
});

/** An agent's record of the user's QA from the user's own message; `dismissed` is stored as `waived`. */
export const EvidenceAgentQaInput = EvidenceAgentQaInputFields.check(
  Schema.makeFilter((input: typeof EvidenceAgentQaInputFields.Type) =>
    (input.state !== "problem" && input.state !== "dismissed") || input.note !== undefined
      ? true
      : `${input.state} needs a note: ${input.state === "problem" ? "what is wrong" : "why"}, in the user's words.`,
  ),
);
export type EvidenceAgentQaInput = typeof EvidenceAgentQaInput.Type;

export const EVIDENCE_THREAD_LANDING_LIMIT = 50;
/** How many landings one thread read may ask for by id. */
export const EVIDENCE_THREAD_REQUEST_LIMIT = 200;

export const EvidenceThreadInput = Schema.Struct({
  threadId: ThreadId,
  /** Landings the loaded timeline places, read even when they are older than the newest page. */
  landingIds: Schema.optional(
    Schema.Array(EvidenceSlug).check(Schema.isMaxLength(EVIDENCE_THREAD_REQUEST_LIMIT)),
  ),
});
export type EvidenceThreadInput = typeof EvidenceThreadInput.Type;

/** The landings a thread shows, recorded in it or for it: the newest, capped, plus any requested. */
export const EvidenceThreadResult = Schema.Struct({ landings: Schema.Array(EvidenceLanding) });
export type EvidenceThreadResult = typeof EvidenceThreadResult.Type;

/** The reason a bulk dismissal offers until the user changes it. */
export const EVIDENCE_BULK_DISMISS_DEFAULT_REASON = "backlog cleared, not individually checked";

/** The most changes one bulk dismissal previews and acts on; the oldest come first. */
export const EVIDENCE_BULK_DISMISS_LIMIT = 5000;

export const EvidenceChangeKey = Schema.Struct({ landingId: EvidenceSlug, changeId: EvidenceSlug });
export type EvidenceChangeKey = typeof EvidenceChangeKey.Type;

const EvidenceBulkDismissChanges = Schema.Array(EvidenceChangeKey).check(
  Schema.isMaxLength(EVIDENCE_BULK_DISMISS_LIMIT),
);

/**
 * The user's bulk dismissal of changes still waiting for QA that landed before `before`, an
 * instant, in every thread. A dry run lists them and changes nothing; the dismissal names the
 * listed changes and acts only on those still waiting, so nothing new is swept in.
 */
export const EvidenceBulkSetQaInput = Schema.Union([
  Schema.Struct({ before: Schema.DateTimeUtcFromString, dryRun: Schema.Literal(true) }),
  Schema.Struct({
    before: Schema.DateTimeUtcFromString,
    note: Text(2000),
    changes: EvidenceBulkDismissChanges,
  }),
]);
export type EvidenceBulkSetQaInput = typeof EvidenceBulkSetQaInput.Type;

export const EvidenceBulkSetQaResult = Schema.Struct({
  /** Changes listed, on a dry run; changes dismissed, otherwise. */
  count: NonNegativeInt,
  /** A dry run's changes, oldest first, to send back with the dismissal. */
  changes: Schema.optional(EvidenceBulkDismissChanges),
  /** A dry run found more than it lists; dismiss these, then run it again. */
  more: Schema.optional(Schema.Boolean),
});
export type EvidenceBulkSetQaResult = typeof EvidenceBulkSetQaResult.Type;

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
  changes: Schema.Array(
    Schema.Struct({
      id: EvidenceSlug,
      qa: EvidenceQaState,
      /** Why the user sees a QA card for it; empty when it was recorded quietly. */
      raised: Schema.Array(EvidenceQaRaiseReason),
      ref: Schema.optional(PositiveInt),
    }),
  ),
  /** Problems kept in the record, such as a capture that is missing. */
  warnings: Schema.Array(Schema.String),
});
export type EvidenceRecordResult = typeof EvidenceRecordResult.Type;

export class EvidenceError extends Schema.TaggedError<EvidenceError>()("EvidenceError", {
  code: Schema.Literals(["invalid", "not_found", "storage"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
