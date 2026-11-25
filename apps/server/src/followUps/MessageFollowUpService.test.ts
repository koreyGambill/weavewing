import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId, type SideChatAnchor } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./MessageFollowUpService.ts";

const testLayer = Service.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(SecureRandom.layerWebCrypto),
);

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
  action: "flag" | "unflag" | "done" | "reopen" | "todo" | "untodo" | "note",
  target: {
    readonly bookmarkId?: string;
    readonly note?: string;
    readonly anchor?: SideChatAnchor;
    readonly todo?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* Service.MessageFollowUpService;
    return yield* service.update({
      threadId: ThreadId.make(threadId),
      messageId: MessageId.make(messageId),
      action,
      ...target,
    });
  });
const passage = (messageId: string, start: number, text: string): SideChatAnchor => ({
  messageId: MessageId.make(messageId),
  text,
  start,
  end: start + text.length,
  prefix: "",
  suffix: "",
});
const list = (threadId?: string, bookmarks?: true) =>
  Effect.gen(function* () {
    const service = yield* Service.MessageFollowUpService;
    return yield* service.list({
      ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
      ...(bookmarks === undefined ? {} : { bookmarks }),
    });
  });

it.effect("flags with a server-side excerpt and walks every reverse state", () =>
  Effect.gen(function* () {
    yield* seed;
    const flagged = yield* update("t1", "m1", "flag");
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
    yield* update("t1", "m1", "flag");
    yield* TestClock.adjust("1 minute");
    yield* update("t2", "m3", "flag");
    yield* update("gone", "m4", "flag");
    assert.deepStrictEqual(
      (yield* list()).map((item) => [item.threadTitle, item.messageId]),
      [
        ["Lead runbook", "m3"],
        ["Building Weavewing", "m1"],
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses messages outside the thread, other authors' messages and unflagged rows", () =>
  Effect.gen(function* () {
    yield* seed;
    for (const [threadId, messageId, action] of [
      ["t2", "m1", "flag"],
      ["t1", "missing", "flag"],
      ["t1", "s1", "flag"],
      // Clients before bookmarks could flag only their own messages.
      ["t1", "m2", "flag"],
      ["t1", "m1", "done"],
      ["t1", "m1", "reopen"],
    ] as const) {
      const error = yield* Effect.flip(update(threadId, messageId, action));
      assert.strictEqual(error.code, "not_found");
    }
    const elsewhere = yield* Effect.flip(
      update("t1", "m1", "flag", { anchor: passage("m2", 0, "Yes") }),
    );
    assert.strictEqual(elsewhere.code, "not_found");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("bookmarks whole replies and several passages, each removable on its own", () =>
  Effect.gen(function* () {
    yield* seed;
    const reply = yield* update("t1", "m2", "flag", { todo: false });
    assert.strictEqual(reply?.role, "assistant");
    assert.isUndefined(reply?.anchor);
    assert.strictEqual(reply?.messageCreatedAt, "2026-01-01T00:00:00.000Z");

    const first = yield* update("t1", "m1", "flag", { anchor: passage("m1", 4, "pin chats") });
    const second = yield* update("t1", "m1", "flag", { anchor: passage("m1", 0, "can") });
    assert.strictEqual(first?.role, "user");
    assert.strictEqual(first?.excerpt, "pin chats");
    assert.deepStrictEqual(first?.anchor, passage("m1", 4, "pin chats"));
    assert.strictEqual(
      (yield* update("t1", "m1", "flag", { anchor: passage("m1", 4, "pin chats") }))?.id,
      first?.id,
    );
    // A passage is not the whole prompt, so the prompt can still be bookmarked by itself.
    const whole = yield* update("t1", "m1", "flag", { todo: true });
    assert.isUndefined(whole?.anchor);
    assert.strictEqual((yield* list("t1", true)).length, 4);

    const done = yield* update("t1", "m1", "done", { bookmarkId: first!.id! });
    assert.strictEqual(done?.id, first?.id);
    assert.isNotNull(done?.doneAt);
    assert.isNull((yield* list("t1", true)).find((item) => item.id === whole?.id)?.doneAt);

    assert.isNull(yield* update("t1", "m1", "unflag", { bookmarkId: first!.id! }));
    assert.deepStrictEqual(
      (yield* list("t1", true)).map((item) => item.id).toSorted(),
      [reply!.id, second!.id, whole!.id].toSorted(),
    );
    const other = yield* Effect.flip(update("t2", "m1", "done", { bookmarkId: second!.id! }));
    assert.strictEqual(other.code, "not_found");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps plain bookmarks out of to-do states until marked as a to-do", () =>
  Effect.gen(function* () {
    yield* seed;
    const plain = yield* update("t1", "m2", "flag", { todo: false });
    assert.isFalse(plain?.todo);
    // Clients before bookmarks send no `todo`, and their follow-ups were to-dos.
    assert.isTrue((yield* update("t2", "m3", "flag"))?.todo);
    const target = { bookmarkId: plain!.id! };
    assert.strictEqual((yield* Effect.flip(update("t1", "m2", "done", target))).code, "not_found");
    assert.deepStrictEqual(
      (yield* list()).map((item) => item.messageId),
      ["m3"],
    );
    assert.deepStrictEqual(
      (yield* list(undefined, true)).map((item) => item.messageId).toSorted(),
      ["m2", "m3"],
    );

    assert.isTrue((yield* update("t1", "m2", "todo", target))?.todo);
    assert.isNotNull((yield* update("t1", "m2", "done", target))?.doneAt);
    const untodo = yield* update("t1", "m2", "untodo", target);
    assert.isFalse(untodo?.todo);
    assert.isNull(untodo?.doneAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "shows clients before bookmarks only whole user-message to-dos, and acts on no other",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const followUp = yield* update("t1", "m1", "flag");
      const passageOfIt = yield* update("t1", "m1", "flag", {
        anchor: passage("m1", 4, "pin chats"),
      });
      yield* update("t1", "m2", "flag", { todo: true });
      yield* update("t2", "m3", "flag", { todo: false });
      assert.deepStrictEqual(
        (yield* list("t1")).map((item) => item.id),
        [followUp!.id],
      );
      assert.deepStrictEqual(
        (yield* list()).map((item) => item.id),
        [followUp!.id],
      );

      // Removing the follow-up leaves the passage bookmarked in the same message.
      assert.isNull(yield* update("t1", "m1", "unflag"));
      assert.deepStrictEqual(
        (yield* list("t1", true)).filter((item) => item.messageId === "m1").map((item) => item.id),
        [passageOfIt!.id],
      );
      // A plain bookmark is not a follow-up, so a legacy done cannot reach it.
      assert.strictEqual((yield* Effect.flip(update("t2", "m3", "done"))).code, "not_found");
      assert.isNull(yield* update("t2", "m3", "unflag"));
      assert.strictEqual((yield* list("t2", true)).length, 1);
      // Flagging it the old way makes it a to-do, as a follow-up would be.
      assert.isTrue((yield* update("t2", "m3", "flag"))?.todo);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("creates one bookmark when identical requests race", () =>
  Effect.gen(function* () {
    yield* seed;
    for (const target of [{ todo: false }, { anchor: passage("m1", 4, "pin chats"), todo: true }]) {
      const results = yield* Effect.all(
        Array.from({ length: 6 }, () => update("t1", "m1", "flag", target)),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(new Set(results.map((item) => item?.id)).size, 1);
    }
    assert.strictEqual((yield* list("t1", true)).length, 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps different quotes saved at the same offsets apart", () =>
  Effect.gen(function* () {
    yield* seed;
    const first = yield* update("t1", "m1", "flag", { anchor: passage("m1", 4, "pin chats") });
    const moved = yield* update("t1", "m1", "flag", { anchor: passage("m1", 4, "pin rooms") });
    assert.notStrictEqual(first?.id, moved?.id);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a note on one bookmark until it is cleared", () =>
  Effect.gen(function* () {
    yield* seed;
    const reply = yield* update("t1", "m2", "flag", { todo: false });
    const target = { bookmarkId: reply!.id! };
    assert.strictEqual(
      (yield* update("t1", "m2", "note", { ...target, note: "  why  " }))?.note,
      "why",
    );
    assert.strictEqual((yield* update("t1", "m2", "todo", target))?.note, "why");
    assert.isUndefined((yield* update("t1", "m2", "note", { ...target, note: " " }))?.note);
    const missing = yield* Effect.flip(update("t1", "m1", "note", { note: "x" }));
    assert.strictEqual(missing.code, "not_found");
  }).pipe(Effect.provide(testLayer)),
);
