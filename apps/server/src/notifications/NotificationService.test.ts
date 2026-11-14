import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  MonitoringFindingId,
  NotificationId,
  ScheduledTaskId,
  ThreadId,
  type NotificationSource,
  type NotificationStreamEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./NotificationService.ts";

const testLayer = Service.layer.pipe(
  Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeCrypto.layer)),
);
const agent = (thread: string): NotificationSource => ({
  kind: "agent",
  threadId: ThreadId.make(thread),
});
const raiseInput = (source: NotificationSource, title: string) => ({
  severity: "warning" as const,
  title,
  source,
  threadId: source.kind === "agent" ? source.threadId : null,
  projectId: null,
});

const subscribe = Effect.gen(function* () {
  const service = yield* Service.NotificationService;
  const events = yield* Queue.unbounded<NotificationStreamEvent>();
  yield* Stream.runForEach(service.subscribe(), (event) => Queue.offer(events, event)).pipe(
    Effect.forkScoped,
  );
  return events;
});

it.effect(
  "walks every reverse state, dedupes repeats and keeps pending ones out of the inbox",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.NotificationService;
      const events = yield* subscribe;
      assert.deepStrictEqual(yield* Queue.take(events), {
        type: "snapshot",
        unreadCount: 0,
        maxUnreadSeverity: null,
        items: [],
      });

      const first = yield* service.raise({
        ...raiseInput(agent("t1"), "Lands ran from bash"),
        body: "one",
      });
      assert.strictEqual(first.status, "delivered");
      const id = first.notification.id;
      assert.deepInclude(yield* Queue.take(events), {
        type: "upsert",
        unreadCount: 1,
        maxUnreadSeverity: "warning",
      });

      const update = (action: Parameters<typeof service.update>[0]["action"]) =>
        service.update({ ids: [id], action }).pipe(Effect.map(({ items }) => items[0]!));
      assert.isNotNull((yield* update({ type: "read" })).readAt);
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 0);
      assert.isNull((yield* update({ type: "unread" })).readAt);
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 1);
      assert.isNotNull((yield* update({ type: "dismiss" })).dismissedAt);
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 0);

      // A repeat resurfaces a dismissed one, asks to be read and, unread, keeps its highest severity.
      yield* update({ type: "read" });
      yield* Queue.take(events);
      const repeat = yield* service.raise({
        ...raiseInput(agent("t1"), "Lands ran from bash"),
        severity: "info",
        body: "two",
      });
      assert.strictEqual(repeat.status, "repeat");
      assert.strictEqual(repeat.notification.id, id);
      assert.strictEqual(repeat.notification.repeatCount, 1);
      assert.strictEqual(repeat.notification.body, "two");
      assert.strictEqual(repeat.notification.severity, "info");
      assert.isNull(repeat.notification.readAt);
      assert.isNull(repeat.notification.dismissedAt);
      assert.deepInclude(yield* Queue.take(events), { unreadCount: 1, maxUnreadSeverity: "info" });
      const louder = yield* service.raise({ ...raiseInput(agent("t1"), "Lands ran from bash") });
      assert.strictEqual(louder.notification.severity, "warning");
      yield* Queue.take(events);
      const quieter = yield* service.raise({
        ...raiseInput(agent("t1"), "Lands ran from bash"),
        severity: "info",
      });
      assert.strictEqual(quieter.notification.severity, "warning");
      yield* Queue.take(events);
      assert.isNotNull((yield* update({ type: "dismiss" })).dismissedAt);
      yield* Queue.take(events);
      assert.isNull((yield* update({ type: "restore" })).dismissedAt);
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 1);

      // A snooze ending publishes the woken item and fresh counts without any other change.
      const until = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
      assert.strictEqual((yield* update({ type: "snooze", until })).snoozedUntil, until);
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 0);
      assert.deepStrictEqual(yield* service.markAllRead(), { count: 0 });
      yield* TestClock.adjust("1 hour");
      const woke = yield* Queue.take(events);
      assert.deepInclude(woke, { type: "upsert", unreadCount: 1 });
      assert.deepStrictEqual(
        woke.items.map((item) => item.id),
        [id],
      );
      // A repeat keeps the snooze.
      yield* update({
        type: "snooze",
        until: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
      });
      yield* Queue.take(events);
      const snoozedRepeat = yield* service.raise(raiseInput(agent("t1"), "Lands ran from bash"));
      assert.isNotNull(snoozedRepeat.notification.snoozedUntil);
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 0);
      assert.isNull((yield* update({ type: "unsnooze" })).snoozedUntil);
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 1);
      assert.deepStrictEqual(yield* service.markAllRead(), { count: 1 });
      assert.strictEqual((yield* Queue.take(events)).unreadCount, 0);

      // The same title for another target thread is its own notification.
      const elsewhere = yield* service.raise({
        ...raiseInput(agent("t1"), "Lands ran from bash"),
        threadId: ThreadId.make("t1-child"),
      });
      assert.notStrictEqual(elsewhere.notification.id, id);
      yield* Queue.take(events);
      yield* service.update({ ids: [elsewhere.notification.id], action: { type: "dismiss" } });
      yield* Queue.take(events);

      // Another thread's identical title is its own notification.
      const other = yield* service.raise({
        ...raiseInput(agent("t2"), "Lands ran from bash"),
        severity: "critical",
      });
      assert.notStrictEqual(other.notification.id, id);
      assert.deepInclude(yield* Queue.take(events), {
        unreadCount: 1,
        maxUnreadSeverity: "critical",
      });

      const pending = yield* service.raise({
        ...raiseInput(
          { kind: "automation", scheduledTaskId: ScheduledTaskId.make("task"), runId: "run" },
          "Exposure",
        ),
        verification: { status: "pending" },
      });
      assert.strictEqual(pending.status, "pending_verification");
      yield* service.update({ ids: [pending.notification.id], action: { type: "read" } });
      // A hidden row takes no repeats, so the next raise is verified on its own.
      const again = yield* service.raise({
        ...raiseInput(
          { kind: "automation", scheduledTaskId: ScheduledTaskId.make("task"), runId: "run-2" },
          "Exposure",
        ),
        verification: { status: "pending" },
      });
      assert.strictEqual(again.status, "pending_verification");
      assert.notStrictEqual(again.notification.id, pending.notification.id);
      const snapshot = yield* Queue.take(yield* subscribe);
      assert.deepStrictEqual(
        snapshot.items.map((item) => item.id),
        [other.notification.id, elsewhere.notification.id, id],
      );
      assert.strictEqual(snapshot.unreadCount, 1);
      assert.strictEqual(yield* Queue.size(events), 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("limits each thread or automation to ten raises an hour and dedupes within a day", () =>
  Effect.gen(function* () {
    const service = yield* Service.NotificationService;
    const task: NotificationSource = {
      kind: "automation",
      scheduledTaskId: ScheduledTaskId.make("task"),
      runId: "run-1",
    };
    for (let index = 0; index < Service.RATE_LIMIT_PER_HOUR; index++) {
      yield* service.raise(raiseInput(agent("noisy"), `finding ${index}`));
      yield* service.raise(raiseInput({ ...task, runId: `run-${index}` }, "same finding"));
    }
    const refused = yield* Effect.flip(service.raise(raiseInput(agent("noisy"), "one more")));
    assert.strictEqual(refused._tag, "NotificationRateLimitedError");
    assert.include(refused.message, "1970-01-01T01:00:00.000Z");
    assert.strictEqual(
      (yield* Effect.flip(service.raise(raiseInput({ ...task, runId: "other" }, "x"))))._tag,
      "NotificationRateLimitedError",
    );
    assert.strictEqual(
      (yield* service.raise(raiseInput(agent("quiet"), "fine"))).status,
      "delivered",
    );

    yield* TestClock.adjust("1 hour");
    assert.strictEqual(
      (yield* service.raise(raiseInput(agent("noisy"), "one more"))).status,
      "delivered",
    );
    // Every run of a task dedupes into one notification for a day, then starts a new one.
    const repeat = yield* service.raise(raiseInput({ ...task, runId: "later" }, "same finding"));
    assert.strictEqual(repeat.status, "repeat");
    assert.strictEqual(repeat.notification.repeatCount, Service.RATE_LIMIT_PER_HOUR);
    assert.deepInclude(repeat.notification.source, { runId: "later" });
    yield* TestClock.adjust("23 hours");
    assert.strictEqual(
      (yield* service.raise(raiseInput({ ...task, runId: "next-day" }, "same finding"))).status,
      "delivered",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("a reassessed finding returns unread with its new report, above newer items", () =>
  Effect.gen(function* () {
    const service = yield* Service.NotificationService;
    const taskId = ScheduledTaskId.make("monitoring:watcher");
    const review = yield* service.raise({
      ...raiseInput(
        {
          kind: "review",
          scheduledTaskId: taskId,
          runId: "run-1",
          findingId: MonitoringFindingId.make("finding-1"),
        },
        "Pushed to main",
      ),
      body: "first report",
      dedupeKey: "finding-1",
    });
    yield* service.update({ ids: [review.notification.id], action: { type: "read" } });
    yield* TestClock.adjust("1 minute");
    yield* service.raise(raiseInput(agent("t1"), "Newer"));
    yield* TestClock.adjust("1 minute");
    yield* service.reviseFinding({
      scheduledTaskId: taskId,
      findingId: "finding-1",
      body: "second",
    });
    const events = yield* subscribe;
    const snapshot = yield* Queue.take(events);
    assert.deepInclude(snapshot.items[0], {
      id: review.notification.id,
      body: "second",
      readAt: null,
      updatedAt: "1970-01-01T00:02:00.000Z",
    });
    assert.strictEqual(snapshot.unreadCount, 2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("skips a row that no longer decodes and refuses an invalid raise before writing", () =>
  Effect.gen(function* () {
    const service = yield* Service.NotificationService;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO notifications (id, created_at, updated_at, severity, title, source_json, dedupe_key, repeat_count)
      VALUES ('notification:legacy', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 'info', 'Old', '{"kind":"legacy"}', 'legacy', 0)`;
    const good = yield* service.raise(raiseInput(agent("t1"), "Lands ran from bash"));
    const events = yield* subscribe;
    const snapshot = yield* Queue.take(events);
    assert.deepStrictEqual(
      snapshot.items.map((item) => item.id),
      [good.notification.id],
    );
    const read = yield* service.update({
      ids: [NotificationId.make("notification:legacy"), good.notification.id],
      action: { type: "read" },
    });
    assert.deepStrictEqual(
      read.items.map((item) => item.id),
      [good.notification.id],
    );
    yield* Queue.take(events);
    yield* service.update({ ids: [good.notification.id], action: { type: "unread" } });
    yield* Queue.take(events);
    assert.deepStrictEqual(yield* service.markAllRead(), { count: 1 });
    assert.strictEqual((yield* Queue.take(events)).unreadCount, 0);

    const refused = yield* Effect.flip(service.raise(raiseInput(agent("t1"), "x".repeat(121))));
    assert.strictEqual(refused._tag, "NotificationInvalidError");
    const rows = yield* sql<{ count: number }>`SELECT count(*) AS count FROM notifications`;
    assert.strictEqual(rows[0]?.count, 2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps waking snoozes after a bad row and after a failed pass", () => {
  const wakeFailed = Deferred.makeUnsafe<void>();
  const logger = Logger.make(({ message }) => {
    if (Array.isArray(message) && message[0] === "Notification snooze wake failed; retrying")
      Deferred.doneUnsafe(wakeFailed, Effect.void);
  });
  return Effect.gen(function* () {
    const service = yield* Service.NotificationService;
    const sql = yield* SqlClient.SqlClient;
    const inHours = (hours: number) =>
      DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(DateTime.add(now, { hours }))));
    const events = yield* subscribe;
    yield* Queue.take(events);
    const first = yield* service.raise(raiseInput(agent("t1"), "first"));
    const second = yield* service.raise(raiseInput(agent("t1"), "second"));
    yield* Queue.take(events);
    yield* Queue.take(events);
    yield* sql`INSERT INTO notifications (id, created_at, updated_at, severity, title, source_json, snoozed_until, dedupe_key, repeat_count)
      VALUES ('notification:legacy', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 'info', 'Old', '{"kind":"legacy"}', ${yield* inHours(1)}, 'legacy', 0)`;
    yield* service.update({
      ids: [first.notification.id],
      action: { type: "snooze", until: yield* inHours(2) },
    });
    yield* Queue.take(events);

    // The bad row wakes first: counts still publish and the same loop wakes the next one.
    yield* TestClock.adjust("1 hour");
    assert.deepInclude(yield* Queue.take(events), { type: "upsert", items: [] });
    yield* TestClock.adjust("1 hour");
    const woke = yield* Queue.take(events);
    assert.deepStrictEqual(
      woke.items.map((item) => item.id),
      [first.notification.id],
    );

    // A failed pass keeps its place and retries, so the wake it missed still publishes.
    yield* service.update({
      ids: [second.notification.id],
      action: { type: "snooze", until: yield* inHours(1) },
    });
    yield* Queue.take(events);
    yield* sql`ALTER TABLE notifications RENAME TO notifications_away`;
    yield* TestClock.adjust("1 hour");
    yield* Deferred.await(wakeFailed);
    yield* sql`ALTER TABLE notifications_away RENAME TO notifications`;
    yield* TestClock.adjust("1 minute");
    const retried = yield* Queue.take(events);
    assert.deepStrictEqual(
      retried.items.map((item) => item.id),
      [second.notification.id],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(testLayer.pipe(Layer.provideMerge(Logger.layer([logger])))),
  );
});
