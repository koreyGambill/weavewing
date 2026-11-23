import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Follow-ups become whole-prompt to-do bookmarks; a message may now hold several passage bookmarks. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE message_bookmarks (
    bookmark_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    anchor_json TEXT,
    todo INTEGER NOT NULL,
    flagged_at TEXT NOT NULL,
    done_at TEXT
  )`;
  yield* sql`INSERT INTO message_bookmarks
    (bookmark_id, thread_id, message_id, role, excerpt, anchor_json, todo, flagged_at, done_at)
    SELECT lower(hex(randomblob(16))), thread_id, message_id, 'user', excerpt, NULL, 1, flagged_at, done_at
    FROM message_follow_ups`;
  yield* sql`DROP TABLE message_follow_ups`;
  yield* sql`CREATE UNIQUE INDEX message_bookmarks_whole_message_idx
    ON message_bookmarks(thread_id, message_id) WHERE anchor_json IS NULL`;
  yield* sql`CREATE INDEX message_bookmarks_thread_idx ON message_bookmarks(thread_id, flagged_at)`;
  yield* sql`CREATE INDEX message_bookmarks_open_idx ON message_bookmarks(todo, done_at, flagged_at)`;
});
