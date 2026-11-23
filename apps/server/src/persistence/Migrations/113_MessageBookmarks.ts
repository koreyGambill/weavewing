import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Copies follow-ups into whole-prompt to-do bookmarks. `message_follow_ups` stays so a rolled-back
 * build still reads it; it then misses only follow-up changes made since this migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A whole-message bookmark has an empty passage key; a passage's key is its offsets and quote.
  yield* sql`CREATE TABLE message_bookmarks (
    bookmark_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    passage_key TEXT NOT NULL,
    role TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    anchor_json TEXT,
    todo INTEGER NOT NULL,
    flagged_at TEXT NOT NULL,
    done_at TEXT
  )`;
  yield* sql`INSERT INTO message_bookmarks
    (bookmark_id, thread_id, message_id, passage_key, role, excerpt, anchor_json, todo, flagged_at, done_at)
    SELECT lower(hex(randomblob(16))), thread_id, message_id, '', 'user', excerpt, NULL, 1, flagged_at, done_at
    FROM message_follow_ups`;
  yield* sql`CREATE UNIQUE INDEX message_bookmarks_identity_idx
    ON message_bookmarks(thread_id, message_id, passage_key)`;
  yield* sql`CREATE INDEX message_bookmarks_thread_idx ON message_bookmarks(thread_id, flagged_at)`;
  yield* sql`CREATE INDEX message_bookmarks_open_idx ON message_bookmarks(todo, done_at, flagged_at)`;
});
