import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("112_InboxImportance", (it) => {
  it.effect("dismisses all active history and preserves dismissed rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 111 });
      for (const [id, severity, kind, key, dismissed] of [
        ["review", "warning", "review", "review:f", null],
        ["evidence", "warning", "agent", "agent:t\nevidence:batch", null],
        ["routine", "info", "agent", "routine", null],
        ["important", "warning", "agent", "important", null],
        ["urgent", "critical", "automation", "urgent", null],
        ["dismissed", "warning", "review", "old", "2000-01-01T00:00:00.000Z"],
      ])
        yield* sql`INSERT INTO notifications (id, created_at, updated_at, severity, title, source_json, dedupe_key, dismissed_at)
      VALUES (${id}, '', '', ${severity}, ${id}, ${JSON.stringify({ kind })}, ${key}, ${dismissed})`;
      const [plan] =
        yield* sql`EXPLAIN QUERY PLAN UPDATE notifications INDEXED BY idx_notifications_inbox SET read_at = '' WHERE dismissed_at IS NULL`;
      assert.include(plan?.detail, "idx_notifications_inbox");
      yield* runMigrations({ toMigrationInclusive: 112 });
      const rows = yield* sql<{
        id: string;
        read_at: string | null;
        dismissed_at: string | null;
      }>`SELECT id, read_at, dismissed_at FROM notifications ORDER BY id`;
      assert.strictEqual(rows.length, 6);
      for (const row of rows) {
        if (row.id === "dismissed") {
          assert.strictEqual(row.dismissed_at, "2000-01-01T00:00:00.000Z");
          assert.isNull(row.read_at);
        } else {
          assert.isNotNull(row.read_at);
          assert.isNotNull(row.dismissed_at);
        }
      }
      yield* runMigrations({ toMigrationInclusive: 112 });
      assert.deepStrictEqual(
        yield* sql`SELECT id, read_at, dismissed_at FROM notifications ORDER BY id`,
        rows,
      );
    }),
  );
});
