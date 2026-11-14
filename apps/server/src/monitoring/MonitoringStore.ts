import {
  MonitoringError,
  MonitoringFinding,
  type MonitoringFindingId,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ReviewWatermark } from "./MonitoringSnapshot.ts";

const decodeFinding = Schema.decodeEffect(Schema.fromJsonString(MonitoringFinding));
const encodeFinding = Schema.encodeEffect(Schema.fromJsonString(MonitoringFinding));
const decodeFindings = Schema.decodeEffect(Schema.Array(Schema.fromJsonString(MonitoringFinding)));
const ReviewWatermarkJson = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({ createdAt: Schema.String, messageId: Schema.String }),
  ),
);
const decodeWatermark = Schema.decodeEffect(ReviewWatermarkJson);
const encodeWatermark = Schema.encodeEffect(ReviewWatermarkJson);

export class MonitoringStore extends Context.Service<
  MonitoringStore,
  {
    readonly getFinding: (
      id: MonitoringFindingId,
    ) => Effect.Effect<MonitoringFinding | null, MonitoringError>;
    /** The task's findings whose notification the user has neither read nor dismissed. */
    readonly listOpenFindings: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<ReadonlyArray<MonitoringFinding>, MonitoringError>;
    /** When the task's newest finished review, other than `exceptRunId`, started. */
    readonly lastReviewAt: (
      taskId: ScheduledTaskId,
      exceptRunId: string | null,
    ) => Effect.Effect<string | null, MonitoringError>;
    readonly saveFinding: (finding: MonitoringFinding) => Effect.Effect<void, MonitoringError>;
    /**
     * Each thread's newest findings, of any outcome, from this task or the other half of the
     * folded watcher it came from.
     */
    readonly listThreadFindings: (
      taskId: ScheduledTaskId,
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<MonitoringFinding>, MonitoringError>;
    /** Per reviewed thread, the newest message a turn-end review of `threadId` has seen. */
    readonly reviewWatermark: (
      taskId: ScheduledTaskId,
      threadId: ThreadId,
    ) => Effect.Effect<ReviewWatermark, MonitoringError>;
    readonly saveReviewWatermark: (
      taskId: ScheduledTaskId,
      threadId: ThreadId,
      reviewed: ReviewWatermark,
    ) => Effect.Effect<void, MonitoringError>;
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
          SELECT 1 FROM notifications n
          -- reviewNotificationDedupeKey, in SQL so the lookup uses the dedupe index.
          WHERE n.dedupe_key = 'review:' || f.profile_id || ':' || f.id || char(10) || f.id
            AND (n.read_at IS NOT NULL OR n.dismissed_at IS NOT NULL))
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
    listThreadFindings: Effect.fn("MonitoringStore.listThreadFindings")(
      function* (taskId, threadIds) {
        if (!threadIds.length) return [];
        // Migration 100 split a watcher into `<id>` and `<id>:turn-end`; both file one set of findings.
        const base = taskId.replace(/:turn-end$/, "");
        return yield* sql<{ payload_json: string }>`SELECT payload_json FROM (
          SELECT payload_json, updated_at, ROW_NUMBER() OVER (
            PARTITION BY thread_id ORDER BY updated_at DESC, id DESC) AS place
          FROM monitoring_findings
          WHERE profile_id IN (${base}, ${`${base}:turn-end`}) AND thread_id IN ${sql.in(threadIds)}
        ) WHERE place <= 20 ORDER BY updated_at DESC`.pipe(
          NodeSqliteClient.readOnly,
          Effect.flatMap((rows) => decodeFindings(rows.map((row) => row.payload_json))),
          Effect.mapError((cause) => new MonitoringError({ operation: "read findings", cause })),
        );
      },
    ),
    reviewWatermark: Effect.fn("MonitoringStore.reviewWatermark")(function* (taskId, threadId) {
      const rows = yield* sql<{ reviewed_json: string }>`SELECT reviewed_json
        FROM monitoring_review_watermarks WHERE task_id = ${taskId} AND thread_id = ${threadId}`.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => new MonitoringError({ operation: "read watermark", cause })),
      );
      return rows[0] === undefined
        ? {}
        : yield* decodeWatermark(rows[0].reviewed_json).pipe(
            Effect.mapError(
              (cause) => new MonitoringError({ operation: "decode watermark", cause }),
            ),
          );
    }),
    saveReviewWatermark: Effect.fn("MonitoringStore.saveReviewWatermark")(
      function (taskId, threadId, reviewed) {
        return encodeWatermark(reviewed).pipe(
          Effect.flatMap(
            (
              json,
            ) => sql`INSERT INTO monitoring_review_watermarks (task_id, thread_id, reviewed_json)
            VALUES (${taskId}, ${threadId}, ${json})
            ON CONFLICT(task_id, thread_id) DO UPDATE SET reviewed_json = excluded.reviewed_json`,
          ),
          Effect.asVoid,
          Effect.mapError((cause) => new MonitoringError({ operation: "save watermark", cause })),
        );
      },
    ),
  });
});
export const layer = Layer.effect(MonitoringStore, make);
