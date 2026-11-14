import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN grant_json TEXT`;
  // The event schedule's run cap moved into the grant, where it applies to every trigger.
  yield* sql`UPDATE scheduled_tasks
    SET grant_json = json_object('maxRunsPerHour', json_extract(schedule_json, '$.maxRunsPerHour')),
      schedule_json = json_remove(schedule_json, '$.maxRunsPerHour')
    WHERE json_valid(schedule_json)
      AND json_extract(schedule_json, '$.type') = 'event'
      AND json_type(schedule_json, '$.maxRunsPerHour') = 'integer'`;
  yield* sql`UPDATE scheduled_tasks SET schedule_json = json_remove(schedule_json, '$.maxRunsPerHour')
    WHERE json_valid(schedule_json) AND json_type(schedule_json, '$.maxRunsPerHour') IS NOT NULL`;
  yield* sql`CREATE INDEX idx_scheduled_task_runs_thread
    ON scheduled_task_runs(thread_id) WHERE thread_id IS NOT NULL`;
});
