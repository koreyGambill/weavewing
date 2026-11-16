import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE message_summary_attempts (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    day TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id)
  )`;
  yield* sql`CREATE INDEX message_summary_attempts_day_idx ON message_summary_attempts(day)`;
});
