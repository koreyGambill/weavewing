import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0116 from "./116_EvidencePrompts.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("116_EvidencePrompts", (it) => {
  it.effect("adds the prompt table, keeps landings, and runs again without changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 115 });
      const at = "2026-11-20T10:00:00.000Z";
      yield* sql`INSERT INTO evidence_landings (landing_id, thread_id, project_id, landed_at, record_json, updated_at)
        VALUES ('kept', 'lead', 'project', ${at}, '{"changes":[]}', ${at})`;

      yield* runMigrations({ toMigrationInclusive: 116 });
      yield* Migration0116;
      const claim = (threadId: string) =>
        sql`INSERT INTO evidence_prompts (project_id, target_sha, thread_id, run_id, message_id, move, position, prompted_at, outcome)
          VALUES ('project', 'abc', ${threadId}, 'run-1', 'message-1', 0, 0, ${at}, 'sent')`;
      yield* claim("lead");
      // One commit of a project is claimed once, whichever thread asks second.
      const duplicate = yield* claim("child").pipe(Effect.exit);
      assert.strictEqual(duplicate._tag, "Failure");
      assert.deepStrictEqual(yield* sql`SELECT landing_id FROM evidence_landings`, [
        { landing_id: "kept" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT project_id, target_sha, thread_id, outcome FROM evidence_prompts`,
        [{ project_id: "project", target_sha: "abc", thread_id: "lead", outcome: "sent" }],
      );
    }),
  );
});
