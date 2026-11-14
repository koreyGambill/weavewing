import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("099_ScheduledTaskGrants", (it) => {
  it.effect("moves the event run cap into the grant", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });
      const schedules = {
        capped: { type: "event", event: "run_ended", cooldownSeconds: 5, maxRunsPerHour: 3 },
        uncapped: { type: "event", event: "thread_created" },
        interval: { type: "interval", everyMs: 60_000 },
      };
      for (const [taskId, schedule] of Object.entries(schedules)) {
        yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
            project_id, workspace_strategy_json, model_selection_json, runtime_mode,
            interaction_mode, created_by, creation_source, created_at, updated_at,
            last_run_status, run_count)
          VALUES (${taskId}, 't', 'p', 1, ${JSON.stringify(schedule)}, 'project', '{}', '{}',
            'full-access', 'default', 'user', 'web', '2026-11-14', '2026-11-14', 'never', 0)`;
      }
      yield* runMigrations();
      const rows = yield* sql<{
        task_id: string;
        schedule_json: string;
        grant_json: string | null;
      }>`SELECT task_id, schedule_json, grant_json FROM scheduled_tasks ORDER BY task_id`;
      assert.deepStrictEqual(
        rows.map((row) => ({
          id: row.task_id,
          schedule: JSON.parse(row.schedule_json),
          grant: row.grant_json === null ? null : JSON.parse(row.grant_json),
        })),
        [
          {
            id: "capped",
            schedule: { type: "event", event: "run_ended", cooldownSeconds: 5 },
            grant: { maxRunsPerHour: 3 },
          },
          { id: "interval", schedule: schedules.interval, grant: null },
          { id: "uncapped", schedule: schedules.uncapped, grant: null },
        ],
      );
    }),
  );
});
