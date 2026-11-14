import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // reviewed_json maps the root thread and each child to the newest message a turn-end review saw.
  yield* sql`CREATE TABLE monitoring_review_watermarks (
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    reviewed_json TEXT NOT NULL,
    PRIMARY KEY (task_id, thread_id)
  )`;
});
