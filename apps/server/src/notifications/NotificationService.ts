import {
  Notification,
  NotificationError,
  NotificationRateLimitedError,
  NotificationSource,
  NotificationVerification,
  type NotificationMarkAllReadResult,
  type NotificationSeverity,
  type NotificationStreamEvent,
  type NotificationUpdateInput,
  type NotificationUpdateResult,
  ProjectId,
  type ScheduledTaskId,
  ThreadId,
  type StatusSource,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { reviewNotificationDedupeKey } from "../monitoring/reviewNotification.ts";

export const RATE_LIMIT_PER_HOUR = 10;
const WAKE_RETRY = Duration.minutes(1);

/** A raise whose fields a notification cannot hold, refused before anything is written. */
export class NotificationInvalidError extends Schema.TaggedError<NotificationInvalidError>()(
  "NotificationInvalidError",
  { detail: Schema.String },
) {
  override get message() {
    return `Invalid notification: ${this.detail}`;
  }
}
const HOUR_MS = 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 24 * HOUR_MS;
const SNAPSHOT_LIMIT = 200;

export interface RaiseInput {
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string | undefined;
  readonly source: NotificationSource;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  /** Defaults to the target thread and title. Scoped to the source, so two threads never share a key. */
  readonly dedupeKey?: string | undefined;
  /**
   * Only delivered notifications take repeats, so a raise behind a pending or rejected one makes a
   * new row. A repeat keeps the delivered row's verification.
   */
  readonly verification?: NotificationVerification | undefined;
}

export interface RaiseResult {
  readonly notification: Notification;
  readonly status: "delivered" | "pending_verification" | "repeat";
}

export class NotificationService extends Context.Service<
  NotificationService,
  {
    readonly raise: (
      input: RaiseInput,
    ) => Effect.Effect<
      RaiseResult,
      NotificationError | NotificationRateLimitedError | NotificationInvalidError
    >;
    readonly observeStatus: (source: StatusSource) => Effect.Effect<void>;
    readonly taskRunFinished: (taskId: ScheduledTaskId) => Effect.Effect<void>;
    readonly update: (
      input: NotificationUpdateInput,
    ) => Effect.Effect<NotificationUpdateResult, NotificationError>;
    readonly markAllRead: () => Effect.Effect<NotificationMarkAllReadResult, NotificationError>;
    /** Keeps historical dismissed review reports up to date. */
    readonly reviseFinding: (input: {
      readonly scheduledTaskId: ScheduledTaskId;
      readonly findingId: string;
      readonly body: string;
    }) => Effect.Effect<void, NotificationError>;
    readonly subscribe: () => Stream.Stream<NotificationStreamEvent, NotificationError>;
  }
>()("t3/notifications/NotificationService") {}

interface Row {
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string | null;
  readonly source_json: string;
  readonly thread_id: string | null;
  readonly project_id: string | null;
  readonly read_at: string | null;
  readonly dismissed_at: string | null;
  readonly snoozed_until: string | null;
  readonly verification_json: string | null;
  readonly repeat_count: number;
}

const decodeNotification = Schema.decodeUnknownEffect(Notification);
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(NotificationSource));
const decodeVerification = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NotificationVerification),
);
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(NotificationSource));
const encodeVerification = Schema.encodeEffect(Schema.fromJsonString(NotificationVerification));

const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, warning: 1, critical: 2 };

const sourceKey = (source: NotificationSource) => {
  switch (source.kind) {
    case "status-source":
      return `status:${source.sourceId}`;
    case "agent":
      return `agent:${source.threadId}`;
    case "automation":
      return `task:${source.scheduledTaskId}`;
    case "review":
      return `review:${source.scheduledTaskId}:${source.findingId}`;
  }
};

const isDelivered = (verification: NotificationVerification | undefined) =>
  verification === undefined ||
  verification.status === "confirmed" ||
  verification.status === "unverified";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.unbounded<NotificationStreamEvent>();
  const mutations = yield* Semaphore.make(1);
  // Raise times per thread or task. A restart forgets them, which only loosens the limit once.
  const raises = new Map<string, Array<number>>();
  const failed = (operation: string) => (cause: unknown) =>
    new NotificationError({ operation, cause });
  const raiseFailed = (cause: unknown) => Effect.fail(failed("raise")(cause));
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => mutations.withPermits(1)(effect);

  // Runs per row inside the traced reads below.
  const toNotification = Effect.fnUntraced(function* (row: Row) {
    const source = yield* decodeSource(row.source_json);
    const verification =
      row.verification_json === null ? undefined : yield* decodeVerification(row.verification_json);
    return yield* decodeNotification({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      severity: row.severity,
      title: row.title,
      ...(row.body === null ? {} : { body: row.body }),
      source,
      threadId: row.thread_id,
      projectId: row.project_id,
      readAt: row.read_at,
      dismissedAt: row.dismissed_at,
      snoozedUntil: row.snoozed_until,
      ...(verification === undefined ? {} : { verification }),
      repeatCount: row.repeat_count,
    });
  });
  // One row that no longer decodes must not hide the others, so it is logged and left out.
  const toNotifications = (rows: ReadonlyArray<Row>) =>
    Effect.forEach(rows, (row) =>
      toNotification(row).pipe(
        Effect.asSome,
        Effect.catch((cause) =>
          Effect.logWarning("Skipping a notification row that does not decode", {
            id: row.id,
            cause,
          }).pipe(Effect.as(Option.none<Notification>())),
        ),
      ),
    ).pipe(Effect.map((decoded) => decoded.flatMap(Option.toArray)));

  const delivered = sql`(verification_json IS NULL OR json_extract(verification_json, '$.status') IN ('confirmed', 'unverified'))`;
  const severityRank = sql`(CASE severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END)`;
  const unread = (now: string) =>
    sql`${delivered} AND read_at IS NULL AND dismissed_at IS NULL AND (snoozed_until IS NULL OR julianday(snoozed_until) <= julianday(${now}))`;

  const counts = Effect.fn("NotificationService.counts")(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql<{
      severity: NotificationSeverity;
      count: number;
    }>`SELECT severity, count(*) AS count FROM notifications WHERE ${unread(now)} GROUP BY severity`;
    let maxUnreadSeverity: NotificationSeverity | null = null;
    for (const row of rows) {
      if (
        maxUnreadSeverity === null ||
        SEVERITY_RANK[row.severity] > SEVERITY_RANK[maxUnreadSeverity]
      )
        maxUnreadSeverity = row.severity;
    }
    return {
      unreadCount: rows.reduce((total, row) => total + row.count, 0),
      maxUnreadSeverity,
    };
  });

  const publish = Effect.fn("NotificationService.publish")(function* (
    items: ReadonlyArray<Notification>,
    countsChanged = false,
  ) {
    const visible = items.filter((item) => isDelivered(item.verification));
    if (visible.length === 0 && !countsChanged) return;
    yield* PubSub.publish(changes, { type: "upsert", ...(yield* counts()), items: visible });
  });

  const reserveRaise = Effect.fn("NotificationService.reserveRaise")(function* (
    source: NotificationSource,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const key = sourceKey(source);
    const recent = (raises.get(key) ?? []).filter((at) => at > now - HOUR_MS);
    if (recent.length >= RATE_LIMIT_PER_HOUR) {
      raises.set(key, recent);
      return yield* new NotificationRateLimitedError({
        limit: RATE_LIMIT_PER_HOUR,
        retryAt: DateTime.formatIso(DateTime.makeUnsafe(recent[0]! + HOUR_MS)),
      });
    }
    raises.set(key, [...recent, now]);
    for (const [other, times] of raises)
      if (times.every((at) => at <= now - HOUR_MS)) raises.delete(other);
  });

  const wakes = yield* FiberHandle.make<void, never>();
  // Snooze ends need no polling worker: one timer sleeps to the earliest end, then publishes the
  // rows woken since its last publish with fresh counts, so badges never go stale. A failed pass
  // keeps that point and retries, so no wake is lost.
  const wakeLoop = Effect.gen(function* () {
    let since = DateTime.formatIso(yield* DateTime.now);
    while (true) {
      const pass = Effect.gen(function* () {
        const wokeAt = yield* DateTime.now;
        const woke = DateTime.formatIso(wokeAt);
        // Publishing last keeps the step from it to the next sleep free of I/O.
        const delayMs = yield* serialized(
          Effect.gen(function* () {
            const rows = yield* sql<Row>`SELECT * FROM notifications WHERE ${delivered}
              AND julianday(snoozed_until) > julianday(${since}) AND julianday(snoozed_until) <= julianday(${woke})
              ORDER BY updated_at DESC, rowid DESC LIMIT ${SNAPSHOT_LIMIT}`;
            const items = yield* toNotifications(rows);
            const next = yield* sql<{
              at: string | null;
            }>`SELECT min(snoozed_until) AS at FROM notifications
              WHERE ${delivered} AND dismissed_at IS NULL AND julianday(snoozed_until) > julianday(${woke})`;
            const at = Option.flatMap(Option.fromNullishOr(next[0]?.at), DateTime.make);
            if (rows.length > 0) yield* publish(items, true);
            return Option.isNone(at)
              ? null
              : DateTime.toEpochMillis(at.value) - DateTime.toEpochMillis(wokeAt);
          }),
        );
        since = woke;
        return delayMs;
      });
      const delayMs = yield* pass.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Notification snooze wake failed; retrying", { cause }).pipe(
            Effect.as(Duration.toMillis(WAKE_RETRY)),
          ),
        ),
      );
      if (delayMs === null) return;
      yield* Effect.sleep(Duration.millis(Math.max(1, Math.ceil(delayMs))));
    }
  });
  const scheduleWake = FiberHandle.run(wakes, wakeLoop).pipe(Effect.asVoid);
  yield* scheduleWake;

  const validate = Effect.fn("NotificationService.validate")(function* (input: RaiseInput) {
    // Warning means important; critical means urgent. Routine work belongs in its thread.
    if (
      input.severity === "info" ||
      input.source.kind === "review" ||
      input.dedupeKey?.startsWith("evidence:")
    )
      return yield* new NotificationInvalidError({
        detail:
          "The inbox is only for urgent problems or important things the human must not miss.",
      });
    const checked = yield* decodeNotification({
      id: "notification:candidate",
      createdAt: "",
      updatedAt: "",
      severity: input.severity,
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      source: input.source,
      threadId: input.threadId,
      projectId: input.projectId,
      readAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      repeatCount: 0,
    }).pipe(Effect.mapError((cause) => new NotificationInvalidError({ detail: cause.message })));
    return {
      severity: checked.severity,
      title: checked.title,
      body: checked.body,
      source: checked.source,
      threadId: checked.threadId,
      projectId: checked.projectId,
      dedupeKey: input.dedupeKey,
      verification: checked.verification,
    } satisfies RaiseInput;
  });

  const raise = Effect.fn("NotificationService.raise")(
    function* (raw: RaiseInput) {
      const input = yield* validate(raw);
      yield* reserveRaise(input.source);
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const windowStart = DateTime.formatIso(
        DateTime.subtract(now, { milliseconds: DEDUPE_WINDOW_MS }),
      );
      const dedupeKey = `${sourceKey(input.source)}\n${input.dedupeKey ?? `${input.threadId ?? ""}\n${input.title}`}`;
      const sourceJson = yield* encodeSource(input.source).pipe(Effect.mapError(failed("encode")));
      const verificationJson =
        input.verification === undefined
          ? null
          : yield* encodeVerification(input.verification).pipe(Effect.mapError(failed("encode")));
      const existing = yield* sql<{
        id: string;
      }>`SELECT id FROM notifications WHERE dedupe_key = ${dedupeKey} AND created_at > ${windowStart} AND ${delivered} ORDER BY created_at DESC LIMIT 1`;
      const id = existing[0]?.id ?? `notification:${yield* random.uuidV4()}`;
      if (existing[0] === undefined) {
        yield* sql`INSERT INTO notifications (id, created_at, updated_at, severity, title, body, source_json, thread_id, project_id, verification_json, dedupe_key, repeat_count)
        VALUES (${id}, ${nowIso}, ${nowIso}, ${input.severity}, ${input.title}, ${input.body ?? null}, ${sourceJson}, ${input.threadId}, ${input.projectId}, ${verificationJson}, ${dedupeKey}, 0)`;
      } else {
        // New activity resurfaces a dismissed one but keeps a snooze; unread, it keeps its highest severity.
        yield* sql`UPDATE notifications SET updated_at = ${nowIso},
        severity = CASE WHEN read_at IS NULL AND ${severityRank} > ${SEVERITY_RANK[input.severity]} THEN severity ELSE ${input.severity} END,
        title = ${input.title}, body = coalesce(${input.body ?? null}, body), source_json = ${sourceJson},
        thread_id = ${input.threadId}, project_id = ${input.projectId},
        read_at = NULL, dismissed_at = NULL, repeat_count = repeat_count + 1 WHERE id = ${id}`;
      }
      const rows = yield* sql<Row>`SELECT * FROM notifications WHERE id = ${id}`;
      const [notification] = yield* toNotifications(rows);
      if (notification === undefined) return yield* new NotificationError({ operation: "raise" });
      yield* publish([notification]);
      if (existing[0] !== undefined) yield* scheduleWake;
      return {
        notification,
        status:
          existing[0] !== undefined
            ? "repeat"
            : isDelivered(notification.verification)
              ? "delivered"
              : "pending_verification",
      } satisfies RaiseResult;
    },
    (effect) => serialized(effect).pipe(Effect.catchTags({ SqlError: raiseFailed })),
  );

  const statusObservations = new Map<
    string,
    { state: string; warnings: number; alerted: boolean }
  >();
  const observeStatus = Effect.fn("NotificationService.observeStatus")(
    function* (source: StatusSource) {
      const id = source.config.id;
      const previous = statusObservations.get(id);
      const state = source.latest.state;
      const warnings = state === "warn" ? (previous?.warnings ?? 0) + 1 : 0;
      const severity = state === "fail" ? "critical" : warnings >= 3 ? "warning" : null;
      const alerted = previous?.state === state && previous.alerted;
      const snoozed =
        source.config.snoozedUntil !== null &&
        Date.parse(source.config.snoozedUntil) > (yield* Clock.currentTimeMillis);
      statusObservations.set(id, { state, warnings, alerted: Boolean(alerted) });
      if (severity === null || alerted || snoozed) return;
      yield* raise({
        severity,
        title:
          `${source.config.name}: ${state === "fail" ? "failing" : "persistent warning"}`.slice(
            0,
            120,
          ),
        body: source.latest.summary.slice(0, 4000) || undefined,
        source: { kind: "status-source", sourceId: id },
        threadId: null,
        projectId: null,
        dedupeKey: state,
      });
      statusObservations.set(id, { state, warnings, alerted: true });
    },
    Effect.catch((cause) => Effect.logWarning("Could not raise status alert", { cause })),
  );

  const taskRunFinished = Effect.fn("NotificationService.taskRunFinished")(
    function* (taskId: ScheduledTaskId) {
      const runs = yield* sql<{
        id: string;
        status: string;
      }>`SELECT id, status FROM scheduled_task_runs
      WHERE task_id = ${taskId} AND ended_at IS NOT NULL AND status != 'skipped'
      ORDER BY started_at DESC, rowid DESC LIMIT 2`;
      if (runs.length !== 2 || !runs.every((run) => run.status === "failed")) return;
      const [task] = yield* sql<{
        title: string;
        thread_id: string | null;
        project_id: string;
      }>`SELECT title, thread_id, project_id FROM scheduled_tasks WHERE task_id = ${taskId}`;
      if (!task) return;
      yield* raise({
        severity: "warning",
        title: `Repeated task failure: ${task.title}`.slice(0, 120),
        body: "The last two scheduled runs failed. Open Scheduled tasks to inspect their run history.",
        source: { kind: "automation", scheduledTaskId: taskId, runId: runs[0]!.id },
        threadId: task.thread_id === null ? null : ThreadId.make(task.thread_id),
        projectId: ProjectId.make(task.project_id),
        dedupeKey: "repeated-failure",
      });
    },
    Effect.catch((cause) => Effect.logWarning("Could not raise repeated task failure", { cause })),
  );

  const update = Effect.fn("NotificationService.update")(
    function* (input: NotificationUpdateInput) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const ids = sql.in(input.ids);
      const targets = sql`id IN ${ids} AND ${delivered}`;
      const action = input.action;
      switch (action.type) {
        case "read":
          yield* sql`UPDATE notifications SET read_at = coalesce(read_at, ${now}) WHERE ${targets}`;
          break;
        case "unread":
          yield* sql`UPDATE notifications SET read_at = NULL WHERE ${targets}`;
          break;
        case "dismiss":
          yield* sql`UPDATE notifications SET dismissed_at = coalesce(dismissed_at, ${now}) WHERE ${targets}`;
          break;
        case "restore":
          yield* sql`UPDATE notifications SET dismissed_at = NULL WHERE ${targets}`;
          break;
        case "snooze":
          yield* sql`UPDATE notifications SET snoozed_until = ${action.until} WHERE ${targets}`;
          break;
        case "unsnooze":
          yield* sql`UPDATE notifications SET snoozed_until = NULL WHERE ${targets}`;
          break;
      }
      const items =
        yield* sql<Row>`SELECT * FROM notifications WHERE ${targets} ORDER BY updated_at DESC, rowid DESC`.pipe(
          Effect.flatMap(toNotifications),
        );
      yield* publish(items);
      yield* scheduleWake;
      return { items };
    },
    (effect) => serialized(effect).pipe(Effect.mapError(failed("update"))),
  );

  const markAllRead = Effect.fn("NotificationService.markAllRead")(
    function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const touched = yield* sql<{
        id: string;
      }>`UPDATE notifications SET read_at = ${now} WHERE ${unread(now)} RETURNING id`;
      // Only rows a client's snapshot window holds; the counts cover the rest.
      const items =
        yield* sql<Row>`SELECT * FROM (SELECT * FROM notifications WHERE ${delivered} ORDER BY updated_at DESC, rowid DESC LIMIT ${SNAPSHOT_LIMIT}) WHERE read_at = ${now}`.pipe(
          Effect.flatMap(toNotifications),
        );
      yield* publish(items, touched.length > 0);
      return { count: touched.length };
    },
    (effect) => serialized(effect).pipe(Effect.mapError(failed("mark all read"))),
  );

  const reviseFinding = Effect.fn("NotificationService.reviseFinding")(
    function* (input: {
      readonly scheduledTaskId: ScheduledTaskId;
      readonly findingId: string;
      readonly body: string;
    }) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows =
        yield* sql<Row>`UPDATE notifications SET body = ${input.body}, updated_at = ${now}
        WHERE dedupe_key = ${reviewNotificationDedupeKey(input.scheduledTaskId, input.findingId)}
        RETURNING *`;
      yield* publish(yield* toNotifications(rows), rows.length > 0);
    },
    (effect) => serialized(effect).pipe(Effect.mapError(failed("revise"))),
  );

  const snapshot = Effect.fn("NotificationService.snapshot")(function* () {
    const items =
      yield* sql<Row>`SELECT * FROM notifications WHERE ${delivered} ORDER BY updated_at DESC, rowid DESC LIMIT ${SNAPSHOT_LIMIT}`.pipe(
        Effect.flatMap(toNotifications),
      );
    return { type: "snapshot", ...(yield* counts()), items } satisfies NotificationStreamEvent;
  });

  return NotificationService.of({
    raise,
    observeStatus,
    taskRunFinished,
    update,
    markAllRead,
    reviseFinding,
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const first = yield* snapshot().pipe(Effect.mapError(failed("read")));
          return Stream.succeed<NotificationStreamEvent>(first).pipe(
            Stream.concat(Stream.fromSubscription(subscription)),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(NotificationService, make);
