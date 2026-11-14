import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./MessageFollowUpService.ts";

const testLayer = Service.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const thread = (id: string, title: string, deletedAt: string | null = null) =>
    sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json)
      VALUES (${id}, 'project', ${title}, 'codex', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt}, '{}')`;
  const message = (id: string, threadId: string, role: string, text: string) =>
    sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${threadId}, ${role}, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${JSON.stringify({ text })})`;
  yield* thread("t1", "Building Weavewing");
  yield* thread("t2", "Lead runbook");
  yield* thread("gone", "Deleted", "2026-01-02T00:00:00.000Z");
  yield* message("m1", "t1", "user", `\n  can we pin chats ${"x".repeat(300)}\nsecond line`);
  yield* message("m2", "t1", "assistant", "Yes.");
  yield* message("m3", "t2", "user", "check the land queue");
  yield* message("m4", "gone", "user", "lost");
  yield* message("s1", "t1", "system", "internal");
});

const update = (
  threadId: string,
  messageId: string,
  action: "flag" | "unflag" | "done" | "reopen",
) =>
  Effect.gen(function* () {
    const service = yield* Service.MessageFollowUpService;
    return yield* service.update({
      threadId: ThreadId.make(threadId),
      messageId: MessageId.make(messageId),
      action,
    });
  });
const list = (threadId?: string) =>
  Effect.gen(function* () {
    const service = yield* Service.MessageFollowUpService;
    return yield* service.list(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) });
  });

it.effect("flags with a server-side excerpt and walks every reverse state", () =>
  Effect.gen(function* () {
    yield* seed;
    const flagged = yield* update("t1", "m1", "flag");
    assert.strictEqual(flagged?.role, "user");
    assert.strictEqual(flagged?.threadTitle, "Building Weavewing");
    assert.strictEqual(flagged?.excerpt.length, 200);
    assert.isTrue(flagged?.excerpt.startsWith("can we pin chats"));
    assert.isTrue(flagged?.excerpt.endsWith("…"));
    assert.isNull(flagged?.doneAt);

    yield* TestClock.adjust("1 minute");
    const again = yield* update("t1", "m1", "flag");
    assert.strictEqual(again?.flaggedAt, flagged?.flaggedAt);

    const done = yield* update("t1", "m1", "done");
    assert.isNotNull(done?.doneAt);
    assert.deepStrictEqual(yield* list(), []);
    assert.deepStrictEqual(
      (yield* list("t1")).map((item) => item.messageId),
      ["m1"],
    );
    assert.isNull((yield* update("t1", "m1", "reopen"))?.doneAt);
    assert.isNull(yield* update("t1", "m1", "unflag"));
    assert.deepStrictEqual(yield* list("t1"), []);
    assert.isNull(yield* update("t1", "m1", "unflag"));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists open follow-ups across live threads, newest first", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* update("t1", "m2", "flag");
    yield* TestClock.adjust("1 minute");
    yield* update("t2", "m3", "flag");
    yield* update("gone", "m4", "flag");
    assert.deepStrictEqual(
      (yield* list()).map((item) => [item.threadTitle, item.excerpt, item.role]),
      [
        ["Lead runbook", "check the land queue", "user"],
        ["Building Weavewing", "Yes.", "assistant"],
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses messages outside the thread and unflagged rows", () =>
  Effect.gen(function* () {
    yield* seed;
    for (const [threadId, messageId, action] of [
      ["t2", "m1", "flag"],
      ["t1", "missing", "flag"],
      ["t1", "s1", "flag"],
      ["t1", "m1", "done"],
      ["t1", "m1", "reopen"],
    ] as const) {
      const error = yield* Effect.flip(update(threadId, messageId, action));
      assert.strictEqual(error.code, "not_found");
    }
  }).pipe(Effect.provide(testLayer)),
);
