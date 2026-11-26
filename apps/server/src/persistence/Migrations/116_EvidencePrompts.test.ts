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
      yield* sql`INSERT INTO evidence_prompts (thread_id, target_sha, run_id, message_id, prompted_at, outcome)
        VALUES ('lead', 'abc', 'run-1', 'message-1', ${at}, 'sent')`;
      const duplicate =
        yield* sql`INSERT INTO evidence_prompts (thread_id, target_sha, run_id, message_id, prompted_at, outcome)
        VALUES ('lead', 'abc', 'run-2', 'message-2', ${at}, 'sent')`.pipe(Effect.exit);
      assert.strictEqual(duplicate._tag, "Failure");
      assert.deepStrictEqual(yield* sql`SELECT landing_id FROM evidence_landings`, [
        { landing_id: "kept" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, target_sha, run_id, outcome FROM evidence_prompts`,
        [{ thread_id: "lead", target_sha: "abc", run_id: "run-1", outcome: "sent" }],
      );
    }),
  );
});
