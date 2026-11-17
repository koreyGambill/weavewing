import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MonitoringFindingId } from "./monitoring.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const NotificationId = TrimmedNonEmptyString.pipe(Schema.brand("NotificationId"));
export type NotificationId = typeof NotificationId.Type;

export const NotificationImportance = Schema.Literals(["urgent", "important"]);

export const NotificationSeverity = Schema.Literals(["info", "warning", "critical"]);
export type NotificationSeverity = typeof NotificationSeverity.Type;

export const NotificationTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export const NotificationBody = TrimmedNonEmptyString.check(Schema.isMaxLength(4000));

export const NotificationSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status-source"), sourceId: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    scheduledTaskId: ScheduledTaskId,
    runId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    scheduledTaskId: ScheduledTaskId,
    runId: TrimmedNonEmptyString,
    findingId: MonitoringFindingId,
  }),
  /** Any agent, through `t3_notify`. */
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
]);
export type NotificationSource = typeof NotificationSource.Type;

export const NotificationVerification = Schema.Struct({
  status: Schema.Literals(["pending", "confirmed", "rejected", "unverified"]),
  model: Schema.optional(
    Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedNonEmptyString }),
  ),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
});
export type NotificationVerification = typeof NotificationVerification.Type;

export const Notification = Schema.Struct({
  id: NotificationId,
  createdAt: IsoDateTime,
  /** When it was last raised; a repeat moves it, reading or snoozing does not. */
  updatedAt: IsoDateTime,
  severity: NotificationSeverity,
  title: NotificationTitle,
  body: Schema.optional(NotificationBody),
  source: NotificationSource,
  /** The thread "Open thread" goes to. */
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  readAt: Schema.NullOr(IsoDateTime),
  dismissedAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  verification: Schema.optional(NotificationVerification),
  repeatCount: NonNegativeInt,
});
export type Notification = typeof Notification.Type;

const NotificationCounts = {
  /** Delivered, unread, not dismissed and not snoozed at the time of the event. */
  unreadCount: NonNegativeInt,
  maxUnreadSeverity: Schema.NullOr(NotificationSeverity),
};

/** A snapshot of the newest delivered notifications, then each change as an upsert. */
export const NotificationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    ...NotificationCounts,
    items: Schema.Array(Notification),
  }),
  Schema.Struct({
    type: Schema.Literal("upsert"),
    ...NotificationCounts,
    items: Schema.Array(Notification),
  }),
]);
export type NotificationStreamEvent = typeof NotificationStreamEvent.Type;

export const NotificationAction = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["read", "unread", "dismiss", "restore", "unsnooze"]) }),
  Schema.Struct({ type: Schema.Literal("snooze"), until: IsoDateTime }),
]);
export type NotificationAction = typeof NotificationAction.Type;

export const NotificationUpdateInput = Schema.Struct({
  ids: Schema.Array(NotificationId).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  action: NotificationAction,
});
export type NotificationUpdateInput = typeof NotificationUpdateInput.Type;

export const NotificationUpdateResult = Schema.Struct({ items: Schema.Array(Notification) });
export type NotificationUpdateResult = typeof NotificationUpdateResult.Type;

export const NotificationMarkAllReadResult = Schema.Struct({ count: NonNegativeInt });
export type NotificationMarkAllReadResult = typeof NotificationMarkAllReadResult.Type;

export class NotificationError extends Schema.TaggedError<NotificationError>()(
  "NotificationError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Notification ${this.operation} failed.`;
  }
}

export class NotificationRateLimitedError extends Schema.TaggedError<NotificationRateLimitedError>()(
  "NotificationRateLimitedError",
  {
    limit: NonNegativeInt,
    retryAt: IsoDateTime,
  },
) {
  override get message() {
    return `At most ${this.limit} notifications per hour from one thread or automation. Try again after ${this.retryAt}.`;
  }
}
