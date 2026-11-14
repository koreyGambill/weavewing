import * as ContextRecords from "../threadInsights/ContextRecords.ts";
import {
  MonitoringError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ConversationMessageJson,
  type OrchestrationV2AppThread,
  type MonitoringReviewOutput,
  ThreadId,
} from "@t3tools/contracts";
import type { ReviewProfile } from "./ReviewProfile.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeThreads = Schema.decodeEffect(
  Schema.Array(Schema.fromJsonString(OrchestrationV2AppThreadJson)),
);
const decodeMessages = Schema.decodeEffect(
  Schema.Array(Schema.fromJsonString(OrchestrationV2ConversationMessageJson)),
);

const PRIOR_CONTEXT_MESSAGES = 2;
const COVERAGE =
  "Chat messages and child-agent chat only; commands, tool activity and files were not inspected. Missing tracking or unobserved changes cannot be inferred from this snapshot.";

export interface MonitoringSnapshotData {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title: string;
    readonly parentThreadId: ThreadId | null;
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly role: string;
      readonly text: string;
      /** Reviewed before; shown only so newer messages can be understood. */
      readonly priorContext?: true;
    }>;
  }>;
  /** Per thread, the newest message this windowed snapshot shows; the next window starts after it. */
  readonly reviewedThrough?: Readonly<Record<string, string>>;
  readonly newestContextAt?: string;
  readonly projectRoot?: string;
  readonly truncated: boolean;
  readonly coverage: string;
}

function monitoringTargetMatches(
  profile: ReviewProfile,
  thread: OrchestrationV2AppThread,
  now: number,
): boolean {
  if (thread.deletedAt !== null || thread.projectId !== profile.projectId) return false;
  if (profile.targets.threadIds.length && !profile.targets.threadIds.includes(thread.id))
    return false;
  const closed =
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.settledOverride !== "active" && thread.settledAt !== null);
  if (profile.targets.state === "active" && closed) return false;
  if (profile.targets.state === "closed" && !closed) return false;
  if (now - DateTime.toEpochMillis(thread.createdAt) < profile.targets.minAgeMs) return false;
  return (
    profile.targets.updatedWithinMs === null ||
    now - DateTime.toEpochMillis(thread.updatedAt) <= profile.targets.updatedWithinMs
  );
}

export function validateMonitoringEvidence(
  output: MonitoringReviewOutput,
  profile: ReviewProfile,
  snapshot: MonitoringSnapshotData,
): boolean {
  return output.findings.every(
    (finding) =>
      profile.rules.some((rule) => rule.id === finding.ruleId) &&
      snapshot.threads.some(
        (thread) => thread.id === finding.threadId && thread.parentThreadId === null,
      ) &&
      finding.evidence.every((evidence) =>
        snapshot.threads.some(
          (thread) =>
            (thread.id === finding.threadId || thread.parentThreadId === finding.threadId) &&
            thread.id === evidence.threadId &&
            thread.messages.some(
              (message) =>
                message.id === evidence.messageId && message.text.includes(evidence.excerpt),
            ),
        ),
      ),
  );
}

export class MonitoringSnapshot extends Context.Service<
  MonitoringSnapshot,
  {
    /** With `watermark`, each thread shows only messages newer than its entry there. */
    readonly capture: (
      profile: ReviewProfile,
      threadId?: ThreadId,
      watermark?: Readonly<Record<string, string>>,
    ) => Effect.Effect<MonitoringSnapshotData, MonitoringError>;
  }
>()("t3/monitoring/MonitoringSnapshot") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const contexts = yield* ContextRecords.ContextRecords;
  return MonitoringSnapshot.of({
    capture: Effect.fn("MonitoringSnapshot.capture")(function* (profile, threadId, watermark) {
      if (threadId !== undefined)
        profile = {
          ...profile,
          targets: {
            state: "all",
            threadIds: [threadId],
            includeChildren: false,
            minAgeMs: 0,
            updatedWithinMs: null,
          },
        };
      const projectRows = profile.includeProjectAgents
        ? yield* sql<{
            workspace_root: string;
          }>`SELECT workspace_root FROM projection_projects WHERE project_id=${profile.projectId} AND deleted_at IS NULL`.pipe(
            NodeSqliteClient.readOnly,
            Effect.mapError(
              (cause) => new MonitoringError({ operation: "read instruction root", cause }),
            ),
          )
        : [];
      const projectRoot = projectRows[0]?.workspace_root;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE project_id=${profile.projectId} AND deleted_at IS NULL AND ${threadId === undefined ? sql`1` : sql`archived_at IS NULL`} AND ${profile.targets.threadIds.length ? sql`thread_id IN ${sql.in(profile.targets.threadIds)}` : sql`1`} ORDER BY updated_at DESC LIMIT 201`.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => new MonitoringError({ operation: "select targets", cause })),
      );
      const threads = yield* decodeThreads(rows.map((row) => row.payload_json)).pipe(
        Effect.mapError((cause) => new MonitoringError({ operation: "decode targets", cause })),
      );
      const selected = threads
        .filter((thread) => monitoringTargetMatches(profile, thread, now))
        .slice(0, 20);
      if (profile.kind === "context-review") {
        const contextThreads: MonitoringSnapshotData["threads"][number][] = [];
        let remaining = 24000;
        let newestContextAt: string | undefined;
        let truncated = selected.length > 5;
        const targets: Array<{ id: ThreadId; title: string; parentThreadId: ThreadId | null }> = [];
        for (const root of selected.slice(0, 5)) {
          if (!targets.some((target) => target.id === root.id))
            targets.push({ id: root.id, title: root.title, parentThreadId: null });
          if (profile.targets.includeChildren) {
            const children = yield* sql<{
              child_thread_id: string;
              title: string;
            }>`SELECT s.child_thread_id,t.title FROM orchestration_v2_projection_subagents s JOIN orchestration_v2_projection_threads t ON t.thread_id=s.child_thread_id WHERE s.thread_id=${root.id} AND t.project_id=${profile.projectId} AND t.deleted_at IS NULL ORDER BY s.updated_at DESC LIMIT 3`.pipe(
              NodeSqliteClient.readOnly,
              Effect.mapError(
                (cause) => new MonitoringError({ operation: "read context children", cause }),
              ),
            );
            if (children.length > 2) truncated = true;
            for (const child of children.slice(0, 2)) {
              const id = ThreadId.make(child.child_thread_id);
              if (!targets.some((target) => target.id === id))
                targets.push({ id, title: child.title, parentThreadId: root.id });
            }
          }
        }
        if (targets.length > 5) truncated = true;
        for (const thread of targets.slice(0, 5)) {
          const result = yield* contexts
            .get({ threadId: thread.id, limit: 5 })
            .pipe(
              Effect.mapError(
                (cause) => new MonitoringError({ operation: "read context records", cause }),
              ),
            );
          if (result.records.length) {
            const ids = result.records.map((record) => record.runId);
            const updates = yield* sql<{ at: string | null }>`
              SELECT at FROM (
                SELECT completed_at AS at FROM orchestration_v2_projection_runs
                  WHERE thread_id=${thread.id} AND run_id IN ${sql.in(ids)}
                UNION ALL SELECT updated_at AS at FROM orchestration_v2_projection_turn_items
                  WHERE thread_id=${thread.id} AND run_id IN ${sql.in(ids)} AND type IN ('command_execution','dynamic_tool','file_search')
                UNION ALL SELECT t.completed_at AS at FROM orchestration_v2_projection_provider_turns t
                  JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=t.run_attempt_id
                  WHERE t.thread_id=${thread.id} AND a.run_id IN ${sql.in(ids)}
              ) WHERE at IS NOT NULL ORDER BY julianday(at) DESC LIMIT 1`.pipe(
              NodeSqliteClient.readOnly,
              Effect.mapError(
                (cause) => new MonitoringError({ operation: "read context freshness", cause }),
              ),
            );
            const at = updates[0]?.at;
            if (
              at &&
              (newestContextAt === undefined || Date.parse(at) > Date.parse(newestContextAt))
            )
              newestContextAt = at;
          }
          const messages = result.records.flatMap((record) => {
            for (const at of [
              record.startedAt,
              ...record.instructions.map((item) => item.capturedAt),
            ])
              if (newestContextAt === undefined || Date.parse(at) > Date.parse(newestContextAt))
                newestContextAt = at;
            const text = JSON.stringify({
              ...record,
              reads: record.reads.toSorted((a, b) => b.count - a.count).slice(0, 20),
              instructions: record.instructions.slice(-2).map((item) => ({
                ...item,
                parts: item.parts.slice(0, 16),
                injectedTools: item.injectedTools?.slice(0, 32),
                instructionSources: item.instructionSources?.slice(0, 16),
              })),
            });
            if (text.length > remaining) {
              truncated = true;
              return [];
            }
            remaining -= text.length;
            return [{ id: `context:${record.runId}`, role: "context record", text }];
          });
          if (
            result.nextBeforeOrdinal !== null ||
            result.records.some(
              (record) =>
                record.truncated ||
                record.reads.length > 20 ||
                record.instructions.length > 2 ||
                record.instructions.some(
                  (item) =>
                    (item.injectedTools?.length ?? 0) > 32 ||
                    (item.instructionSources?.length ?? 0) > 16 ||
                    item.parts.length > 16,
                ),
            )
          )
            truncated = true;
          contextThreads.push({
            id: thread.id,
            title: thread.title.slice(0, 256),
            parentThreadId: thread.parentThreadId,
            messages,
          });
        }
        return {
          ...(projectRoot === undefined ? {} : { projectRoot }),
          ...(newestContextAt === undefined ? {} : { newestContextAt }),
          threads: contextThreads.some((thread) => thread.messages.length) ? contextThreads : [],
          truncated,
          coverage:
            "Recent context records only, at most five threads and five turns each within 24,000 characters. Inferred reads and estimates are uncertain; automatic harness loads may be missing. No file contents were read for this review.",
        };
      }
      const result: Array<MonitoringSnapshotData["threads"][number]> = [];
      const reviewedThrough: Record<string, string> = { ...watermark };
      let remaining = 80_000;
      let truncated =
        rows.length > 200 ||
        selected.length <
          threads.filter((thread) => monitoringTargetMatches(profile, thread, now)).length;
      for (const root of selected) {
        const children = profile.targets.includeChildren
          ? yield* sql<{
              child_thread_id: string;
            }>`SELECT child_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id=${root.id} AND child_thread_id IS NOT NULL ORDER BY updated_at DESC LIMIT 9`.pipe(
              NodeSqliteClient.readOnly,
              Effect.mapError(
                (cause) => new MonitoringError({ operation: "read children", cause }),
              ),
            )
          : [];
        if (children.length > 8) truncated = true;
        const ids = [
          { id: root.id, parentThreadId: null },
          ...children
            .slice(0, 8)
            .map((child) => ({ id: child.child_thread_id, parentThreadId: root.id })),
        ];
        for (const item of ids) {
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          const since = watermark?.[item.id];
          const records = yield* sql<{
            payload_json: string;
            created_at: string;
          }>`SELECT payload_json, created_at FROM orchestration_v2_projection_messages WHERE thread_id=${item.id} AND streaming=0 AND ${since === undefined ? sql`1` : sql`created_at > ${since}`} ORDER BY created_at DESC, message_id DESC LIMIT 41`.pipe(
            NodeSqliteClient.readOnly,
            Effect.mapError((cause) => new MonitoringError({ operation: "read messages", cause })),
          );
          if (records.length > 40) truncated = true;
          const earlier =
            since === undefined
              ? []
              : yield* sql<{
                  payload_json: string;
                  created_at: string;
                }>`SELECT payload_json, created_at FROM orchestration_v2_projection_messages WHERE thread_id=${item.id} AND streaming=0 AND created_at <= ${since} ORDER BY created_at DESC, message_id DESC LIMIT ${PRIOR_CONTEXT_MESSAGES}`.pipe(
                  NodeSqliteClient.readOnly,
                  Effect.mapError(
                    (cause) => new MonitoringError({ operation: "read messages", cause }),
                  ),
                );
          const ordered = [
            ...earlier.toReversed().map((record) => ({ record, priorContext: true })),
            ...records
              .slice(0, 40)
              .toReversed()
              .map((record) => ({ record, priorContext: false })),
          ];
          const messages = yield* decodeMessages(
            ordered.map(({ record }) => record.payload_json),
          ).pipe(
            Effect.mapError(
              (cause) => new MonitoringError({ operation: "decode messages", cause }),
            ),
          );
          let newest: string | undefined;
          const bounded = messages.flatMap((message, index) => {
            const { record, priorContext } = ordered[index]!;
            const cap = priorContext ? 1000 : 4000;
            const text = message.text.slice(0, Math.min(cap, remaining));
            remaining -= text.length;
            if (!text) return [];
            if (!priorContext) {
              if (text.length < message.text.length) truncated = true;
              newest = record.created_at;
            }
            return [
              {
                id: message.id,
                role: message.role,
                text,
                ...(priorContext ? { priorContext: true as const } : {}),
              },
            ];
          });
          if (newest !== undefined) reviewedThrough[item.id] = newest;
          result.push({
            id: root.id === item.id ? root.id : ThreadId.make(item.id),
            title: item.parentThreadId === null ? root.title : "Child agent",
            parentThreadId: item.parentThreadId,
            messages: bounded,
          });
        }
      }
      return {
        ...(projectRoot === undefined ? {} : { projectRoot }),
        ...(watermark === undefined ? {} : { reviewedThrough }),
        threads: result,
        truncated,
        coverage:
          watermark === undefined
            ? COVERAGE
            : `${COVERAGE} Only messages since this thread's last review; priorContext messages were reviewed before and are included for understanding.`,
      };
    }),
  });
});
export const layer = Layer.effect(MonitoringSnapshot, make);
