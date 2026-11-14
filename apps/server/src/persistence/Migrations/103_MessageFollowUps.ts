import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE message_follow_ups (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    flagged_at TEXT NOT NULL,
    done_at TEXT,
    PRIMARY KEY (thread_id, message_id)
  )`;
  yield* sql`CREATE INDEX message_follow_ups_open_idx ON message_follow_ups(done_at, flagged_at)`;
});
