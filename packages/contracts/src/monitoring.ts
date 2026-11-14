import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const MonitoringFindingId = TrimmedNonEmptyString.pipe(Schema.brand("MonitoringFindingId"));
export type MonitoringFindingId = typeof MonitoringFindingId.Type;
export const MonitoringRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  instructions: TrimmedNonEmptyString,
});
export type MonitoringRule = typeof MonitoringRule.Type;

export const MAX_REVIEW_RULES = 32;
export const MAX_REVIEW_INSTRUCTION_FILES = 32;

export const ReviewInstructionFile = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter(
    (path) =>
      path.startsWith("/") ||
      path.startsWith("~/") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.startsWith("\\\\"),
  ),
);

/** Which threads a review looks at. An event-triggered review looks at the event's thread. */
export const ReviewTargets = Schema.Struct({
  state: Schema.Literals(["active", "closed", "all"]),
  threadIds: Schema.Array(ThreadId),
  includeChildren: Schema.Boolean,
  minAgeMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedWithinMs: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type ReviewTargets = typeof ReviewTargets.Type;

export const DEFAULT_REVIEW_TARGETS: ReviewTargets = {
  state: "active",
  threadIds: [],
  includeChildren: true,
  minAgeMs: 15 * 60_000,
  updatedWithinMs: null,
};

/** A tool-less review of thread transcripts against rules; findings become notifications. */
export const ScheduledTaskReviewAgent = Schema.Struct({
  type: Schema.Literal("review"),
  kind: Schema.Literals(["standards", "context-review"]),
  rules: Schema.Array(MonitoringRule).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_REVIEW_RULES),
  ),
  instructionFiles: Schema.optional(
    Schema.Array(ReviewInstructionFile).check(Schema.isMaxLength(MAX_REVIEW_INSTRUCTION_FILES)),
  ),
  includeProjectAgents: Schema.optional(Schema.Boolean),
  targets: ReviewTargets,
  /** `thread-or-alert` also sends each finding to its thread as an advisory. */
  delivery: Schema.Literals(["thread-or-alert", "alerts"]),
});
export type ScheduledTaskReviewAgent = typeof ScheduledTaskReviewAgent.Type;

export const MonitoringEvidence = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  excerpt: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
});
export type MonitoringEvidence = typeof MonitoringEvidence.Type;
const MonitoringFindingContent = Schema.Struct({
  threadId: ThreadId,
  ruleId: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  evidence: Schema.Array(MonitoringEvidence).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export const MonitoringReviewOutput = Schema.Struct({
  findings: Schema.Array(MonitoringFindingContent).check(Schema.isMaxLength(32)),
});
export type MonitoringReviewOutput = typeof MonitoringReviewOutput.Type;
export const MonitoringExchange = Schema.Struct({
  id: TrimmedNonEmptyString,
  at: IsoDateTime,
  role: Schema.Literals(["monitor", "agent", "user"]),
  text: TrimmedNonEmptyString,
});
export type MonitoringExchange = typeof MonitoringExchange.Type;
/** Its inbox state (read, snoozed, dismissed) lives on the finding's notification. */
export const MonitoringFinding = Schema.Struct({
  ...MonitoringFindingContent.fields,
  ruleSnapshot: Schema.optional(MonitoringRule),
  id: MonitoringFindingId,
  taskId: ScheduledTaskId,
  runId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  exchanges: Schema.Array(MonitoringExchange),
  outcome: Schema.NullOr(Schema.String),
  sentToThread: Schema.optional(Schema.Struct({ messageId: MessageId, at: IsoDateTime })),
});
export type MonitoringFinding = typeof MonitoringFinding.Type;
export class MonitoringError extends Schema.TaggedError<MonitoringError>()("MonitoringError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Monitoring ${this.operation} failed.`;
  }
}

export const MonitoringAssessment = Schema.Struct({
  outcome: Schema.Literals(["corrected", "accepted_explanation", "unresolved", "unverified"]),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  evidence: Schema.Array(MonitoringEvidence).check(Schema.isMaxLength(8)),
});
export type MonitoringAssessment = typeof MonitoringAssessment.Type;
