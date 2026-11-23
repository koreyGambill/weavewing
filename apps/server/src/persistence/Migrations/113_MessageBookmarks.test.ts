import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("113_MessageBookmarks", (it) => {
  it.effect("keeps every follow-up as a whole user message to-do bookmark", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 112 });
      yield* sql`INSERT INTO message_follow_ups (thread_id, message_id, excerpt, flagged_at, done_at)
        VALUES ('t1', 'm1', 'open', '2026-01-01T00:00:00.000Z', NULL),
          ('t1', 'm2', 'done', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`;
      yield* runMigrations({ toMigrationInclusive: 113 });
      const rows = yield* sql<{
        bookmark_id: string;
        message_id: string;
        role: string;
        excerpt: string;
        anchor_json: string | null;
        todo: number;
        done_at: string | null;
      }>`SELECT bookmark_id, message_id, role, excerpt, anchor_json, todo, done_at
        FROM message_bookmarks ORDER BY message_id`;
      assert.deepStrictEqual(
        rows.map(({ bookmark_id: _id, ...row }) => row),
        [
          {
            message_id: "m1",
            role: "user",
            excerpt: "open",
            anchor_json: null,
            todo: 1,
            done_at: null,
          },
          {
            message_id: "m2",
            role: "user",
            excerpt: "done",
            anchor_json: null,
            todo: 1,
            done_at: "2026-01-03T00:00:00.000Z",
          },
        ],
      );
      assert.notStrictEqual(rows[0]?.bookmark_id, rows[1]?.bookmark_id);
      // A message has at most one whole-message bookmark.
      yield* Effect.flip(
        sql`INSERT INTO message_bookmarks (bookmark_id, thread_id, message_id, passage_key, role, excerpt, todo, flagged_at)
          VALUES ('again', 't1', 'm1', '', 'user', '', 0, '')`,
      );
      // A rolled-back build still reads its follow-ups.
      assert.deepStrictEqual(
        yield* sql`SELECT message_id, excerpt, done_at FROM message_follow_ups ORDER BY message_id`,
        [
          { message_id: "m1", excerpt: "open", done_at: null },
          { message_id: "m2", excerpt: "done", done_at: "2026-01-03T00:00:00.000Z" },
        ],
      );
    }),
  );
});
