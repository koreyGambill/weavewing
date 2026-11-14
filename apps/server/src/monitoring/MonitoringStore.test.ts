import { assert, it } from "@effect/vitest";
import { ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { reviewNotificationDedupeKey } from "./reviewNotification.ts";
import * as Store from "./MonitoringStore.ts";

const taskId = ScheduledTaskId.make("monitoring:watcher");
const finding = (id: string) => ({
  id,
  taskId,
  runId: "run:1",
  threadId: "thread",
  ruleId: "rule",
  summary: `Finding ${id}`,
  detail: "Detail",
  confidence: 0.5,
  evidence: [{ threadId: "thread", messageId: "message", excerpt: "quote" }],
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
  exchanges: [],
  outcome: null,
});

it.effect("re-delivers only findings the user has neither read nor dismissed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const store = yield* Store.MonitoringStore;
    for (const [id, readAt, dismissedAt] of [
      ["unread", null, null],
      ["read", "2026-11-11T00:00:00.000Z", null],
      ["dismissed", null, "2026-11-11T00:00:00.000Z"],
    ] as const) {
      yield* sql`INSERT INTO monitoring_findings (id, profile_id, thread_id, updated_at, payload_json)
        VALUES (${id}, ${taskId}, 'thread', '2026-11-10T00:00:00.000Z', ${JSON.stringify(finding(id))})`;
      yield* sql`INSERT INTO notifications (id, created_at, updated_at, severity, title, source_json,
          read_at, dismissed_at, dedupe_key)
        VALUES (${`notification:${id}`}, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z',
          'warning', ${id}, '{}', ${readAt}, ${dismissedAt}, ${reviewNotificationDedupeKey(taskId, id)})`;
    }
    assert.deepStrictEqual(
      (yield* store.listOpenFindings(taskId)).map((open) => open.id),
      ["unread"],
    );
  }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
