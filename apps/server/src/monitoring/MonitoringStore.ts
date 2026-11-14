import {
  MonitoringError,
  MonitoringFinding,
  type MonitoringFindingId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeFinding = Schema.decodeEffect(Schema.fromJsonString(MonitoringFinding));
const encodeFinding = Schema.encodeEffect(Schema.fromJsonString(MonitoringFinding));
const decodeFindings = Schema.decodeEffect(Schema.Array(Schema.fromJsonString(MonitoringFinding)));

export class MonitoringStore extends Context.Service<
  MonitoringStore,
  {
    readonly getFinding: (
      id: MonitoringFindingId,
    ) => Effect.Effect<MonitoringFinding | null, MonitoringError>;
    /** The task's findings whose notification the user has not dismissed. */
    readonly listOpenFindings: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<ReadonlyArray<MonitoringFinding>, MonitoringError>;
    /** When the task's newest finished review, other than `exceptRunId`, started. */
    readonly lastReviewAt: (
      taskId: ScheduledTaskId,
      exceptRunId: string | null,
    ) => Effect.Effect<string | null, MonitoringError>;
    readonly saveFinding: (finding: MonitoringFinding) => Effect.Effect<void, MonitoringError>;
  }
>()("t3/monitoring/MonitoringStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return MonitoringStore.of({
    getFinding: Effect.fn("MonitoringStore.getFinding")(function* (id) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM monitoring_findings WHERE id = ${id}`.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => new MonitoringError({ operation: "read finding", cause })),
      );
      return rows[0] === undefined
        ? null
        : yield* decodeFinding(rows[0].payload_json).pipe(
            Effect.mapError((cause) => new MonitoringError({ operation: "decode finding", cause })),
          );
    }),
    listOpenFindings: Effect.fn("MonitoringStore.listOpenFindings")(function* (taskId) {
      return yield* sql<{ payload_json: string }>`SELECT f.payload_json FROM monitoring_findings f
        WHERE f.profile_id = ${taskId} AND NOT EXISTS (
          SELECT 1 FROM notifications n WHERE json_extract(n.source_json, '$.findingId') = f.id
            AND n.dismissed_at IS NOT NULL)
        ORDER BY f.updated_at DESC LIMIT 500`.pipe(
        NodeSqliteClient.readOnly,
        Effect.flatMap((rows) => decodeFindings(rows.map((row) => row.payload_json))),
        Effect.mapError((cause) => new MonitoringError({ operation: "read findings", cause })),
      );
    }),
    lastReviewAt: Effect.fn("MonitoringStore.lastReviewAt")(function* (taskId, exceptRunId) {
      const rows = yield* sql<{ started_at: string }>`SELECT started_at FROM scheduled_task_runs
        WHERE task_id = ${taskId} AND status IN ('quiet', 'notified') AND id IS NOT ${exceptRunId}
        ORDER BY started_at DESC LIMIT 1`.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => new MonitoringError({ operation: "read runs", cause })),
      );
      return rows[0]?.started_at ?? null;
    }),
    saveFinding: Effect.fn("MonitoringStore.saveFinding")(function (finding) {
      return encodeFinding(finding).pipe(
        Effect.flatMap(
          (json) =>
            sql`INSERT INTO monitoring_findings (id, profile_id, thread_id, updated_at, payload_json) VALUES (${finding.id}, ${finding.taskId}, ${finding.threadId}, ${finding.updatedAt}, ${json}) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, payload_json=excluded.payload_json`,
        ),
        Effect.asVoid,
        Effect.mapError((cause) => new MonitoringError({ operation: "save finding", cause })),
      );
    }),
  });
});
export const layer = Layer.effect(MonitoringStore, make);
