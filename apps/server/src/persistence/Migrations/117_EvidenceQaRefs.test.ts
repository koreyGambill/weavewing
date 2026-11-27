import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0117 from "./117_EvidenceQaRefs.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("117_EvidenceQaRefs", (it) => {
  it.effect("seeds each lead thread's highest QA number ever stored, and runs twice safely", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 115 });
      const refs = () =>
        sql<{
          readonly qa_thread_id: string;
          readonly last_ref: number;
        }>`SELECT qa_thread_id, last_ref FROM evidence_qa_refs ORDER BY qa_thread_id`.pipe(
          Effect.map((rows) => rows.map((row) => [row.qa_thread_id, row.last_ref])),
        );

      // An empty database gets the table and no rows.
      yield* Migration0117;
      assert.deepStrictEqual(yield* refs(), []);

      const now = "2026-11-26T10:00:00.000Z";
      for (const [landing, thread, qaThread] of [
        ["lead-a-1", "lead-a", "lead-a"],
        ["child-of-a", "child", "lead-a"],
        ["lead-b-1", "lead-b", null],
        ["lead-c-1", "lead-c", "lead-c"],
      ] as const)
        yield* sql`INSERT INTO evidence_landings (landing_id, thread_id, qa_thread_id, project_id, landed_at, record_json, updated_at)
          VALUES (${landing}, ${thread}, ${qaThread}, 'project', ${now}, '{"changes":[]}', ${now})`;
      for (const [landing, change, state, ref] of [
        ["lead-a-1", "open", "pending", 2],
        // The highest number is on a settled change in a delegated child's landing.
        ["child-of-a", "settled", "confirmed", 7],
        ["lead-a-1", "quiet", "quiet", null],
        // A legacy landing with no QA thread files under its own thread.
        ["lead-b-1", "legacy", "waived", 4],
        ["lead-c-1", "quiet-with-number", "quiet", 3],
      ] as const)
        yield* sql`INSERT INTO evidence_qa (landing_id, change_id, state, note, updated_at, by, ref)
          VALUES (${landing}, ${change}, ${state}, '', ${now}, 'server', ${ref})`;

      yield* Migration0117;
      const expected = [
        ["lead-a", 7],
        ["lead-b", 4],
        ["lead-c", 3],
      ];
      assert.deepStrictEqual(yield* refs(), expected);
      // Running it again changes nothing, and never lowers a mark already handed out.
      yield* sql`UPDATE evidence_qa_refs SET last_ref = 9 WHERE qa_thread_id = 'lead-a'`;
      yield* Migration0117;
      assert.deepStrictEqual(yield* refs(), [["lead-a", 9], ...expected.slice(1)]);
    }),
  );
});
