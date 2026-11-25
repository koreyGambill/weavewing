import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0115 from "./115_EvidenceQaCards.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("115_EvidenceQaCards", (it) => {
  it.effect(
    "keeps existing QA readable, renames failed and files child landings under the lead",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 114 });
        const now = "2026-11-20T10:00:00.000Z";
        for (const [id, parent] of [
          ["lead", null],
          ["child", "lead"],
          ["grandchild", "child"],
        ] as const) {
          const payload = JSON.stringify({
            lineage: { parentThreadId: parent, relationshipToParent: parent ? "subagent" : null },
          });
          yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider,
            runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, ${payload})`;
        }
        const record = (ids: ReadonlyArray<string>) =>
          JSON.stringify({ changes: ids.map((id) => ({ id })) });
        for (const [landing, thread, landedAt, ids] of [
          ["older", "lead", "2026-11-20T11:00:00.000Z", ["b", "a"]],
          ["newer", "grandchild", "2026-11-20T12:00:00.000Z", ["c"]],
          ["unknown-thread", "gone", "2026-11-20T13:00:00.000Z", ["d"]],
        ] as const) {
          yield* sql`INSERT INTO evidence_landings (landing_id, thread_id, project_id, landed_at, record_json, updated_at)
          VALUES (${landing}, ${thread}, 'project', ${landedAt}, ${record(ids)}, ${landedAt})`;
        }
        for (const [landing, change, state] of [
          ["older", "b", "pending"],
          ["older", "a", "failed"],
          ["newer", "c", "waived"],
          ["unknown-thread", "d", "confirmed"],
        ] as const)
          yield* sql`INSERT INTO evidence_qa (landing_id, change_id, state, note, updated_at)
          VALUES (${landing}, ${change}, ${state}, 'kept', ${now})`;

        yield* runMigrations({ toMigrationInclusive: 115 });
        const read = () =>
          sql<{
            readonly landing_id: string;
            readonly change_id: string;
            readonly state: string;
            readonly note: string;
            readonly by: string;
            readonly ref: number;
            readonly raised_json: string | null;
            readonly qa_thread_id: string;
          }>`SELECT q.landing_id, q.change_id, q.state, q.note, q.by, q.ref, q.raised_json, l.qa_thread_id
          FROM evidence_qa q JOIN evidence_landings l USING (landing_id) ORDER BY q.landing_id, q.change_id`;
        const expected = [
          ["newer", "c", "waived", "kept", "user", 3, null, "lead"],
          ["older", "a", "problem", "kept", "user", 2, null, "lead"],
          ["older", "b", "pending", "kept", "user", 1, null, "lead"],
          ["unknown-thread", "d", "confirmed", "kept", "user", 1, null, "gone"],
        ];
        const rows = (yield* read()).map((row) => Object.values(row));
        assert.deepStrictEqual(rows, expected);

        // Running it again changes nothing.
        yield* Migration0115;
        assert.deepStrictEqual(
          (yield* read()).map((row) => Object.values(row)),
          expected,
        );
      }),
  );
});
