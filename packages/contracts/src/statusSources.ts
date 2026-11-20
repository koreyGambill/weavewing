import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Url = Schema.String.check(Schema.isMaxLength(4096));
const Timestamp = Schema.String.check(Schema.isMaxLength(64));

export const StatusState = Schema.Literals(["ok", "warn", "fail", "unknown"]);
export type StatusState = typeof StatusState.Type;

export const StatusSourceKind = Schema.Literals([
  "wing-status",
  "http-health",
  "command",
  "webhook",
]);
export type StatusSourceKind = typeof StatusSourceKind.Type;

export const StatusItem = Schema.Struct({
  name: Name,
  state: StatusState,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  url: Schema.optional(Url),
  updatedAt: Schema.optional(Timestamp),
});
export type StatusItem = typeof StatusItem.Type;

export const StatusPayload = Schema.Struct({
  source: Name,
  state: StatusState,
  summary: Schema.String.check(Schema.isMaxLength(1000)),
  url: Schema.optional(Url),
  updatedAt: Schema.optional(Timestamp),
  items: Schema.Array(StatusItem).check(Schema.isMaxLength(100)),
});
export type StatusPayload = typeof StatusPayload.Type;

export const StatusSourceIntervalSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 30, maximum: 86400 }),
);
export const StatusSourceTimeoutSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 60 }),
);

export const StatusSourceConfig = Schema.Struct({
  id: Name,
  name: Name,
  kind: StatusSourceKind,
  icon: Schema.String.check(Schema.isMaxLength(100)),
  intervalSeconds: StatusSourceIntervalSeconds,
  timeoutSeconds: StatusSourceTimeoutSeconds,
  snoozedUntil: Schema.NullOr(Timestamp),
  target: Schema.String.check(Schema.isMaxLength(8192)),
  hasCredentials: Schema.Boolean,
  /** Linked environments mirror a shared source and alert on it too. */
  shared: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type StatusSourceConfig = typeof StatusSourceConfig.Type;

export const StatusSource = Schema.Struct({
  config: StatusSourceConfig,
  latest: StatusPayload,
  lastTransition: Schema.NullOr(
    Schema.Struct({ from: StatusState, to: StatusState, at: Timestamp }),
  ),
  favicon: Schema.optional(Schema.String.check(Schema.isMaxLength(131072))),
  /** Set on a read-only copy of a source shared by a linked environment. */
  origin: Schema.optional(Schema.Struct({ environmentId: EnvironmentId, label: Name })),
});
export type StatusSource = typeof StatusSource.Type;
export const StatusSourceList = Schema.Array(StatusSource);

export const StatusSourceUpsertInput = Schema.Struct({
  id: Schema.optional(Name),
  name: Name,
  kind: StatusSourceKind,
  icon: StatusSourceConfig.fields.icon,
  intervalSeconds: Schema.optional(StatusSourceIntervalSeconds),
  timeoutSeconds: Schema.optional(StatusSourceTimeoutSeconds),
  target: Schema.optional(StatusSourceConfig.fields.target),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  shared: Schema.optional(Schema.Boolean),
});
export type StatusSourceUpsertInput = typeof StatusSourceUpsertInput.Type;

export const StatusSourceDeleteInput = Schema.Struct({ id: Name });
export type StatusSourceDeleteInput = typeof StatusSourceDeleteInput.Type;
export const StatusSourceReorderInput = Schema.Struct({
  ids: Schema.Array(Name).check(Schema.isMaxLength(64)),
});
export type StatusSourceReorderInput = typeof StatusSourceReorderInput.Type;
export const StatusSourceSnoozeInput = Schema.Struct({ id: Name, until: Schema.NullOr(Timestamp) });
export type StatusSourceSnoozeInput = typeof StatusSourceSnoozeInput.Type;
export const StatusSourceRotateWebhookSecretInput = StatusSourceDeleteInput;
export const StatusSourceRotateWebhookSecretResult = Schema.Struct({ secret: Schema.String });

export class StatusSourcesError extends Schema.TaggedError<StatusSourcesError>()(
  "StatusSourcesError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Status source operation failed.";
  }
}
