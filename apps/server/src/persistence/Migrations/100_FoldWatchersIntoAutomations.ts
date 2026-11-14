import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  reviewNotificationBody,
  reviewNotificationDedupeKey,
  reviewNotificationTitle,
} from "../../monitoring/reviewNotification.ts";

// Stored watcher shapes from migration 083, read loosely: nothing here may drop a user's row.
interface StoredProfile {
  readonly id: string;
  readonly title: string;
  readonly kind?: "standards" | "context-review";
  readonly projectId: string;
  readonly scheduledTaskId?: string;
  readonly turnEnd?: { readonly cooldownMs?: number; readonly allProjects?: boolean };
  readonly delivery?: "thread-or-alert" | "alerts";
  readonly instructionFiles?: ReadonlyArray<string>;
  readonly includeProjectAgents?: boolean;
  readonly targets: unknown;
  readonly rules: ReadonlyArray<unknown>;
}

interface StoredFinding {
  readonly id: string;
  readonly profileId?: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly threadId: string;
  readonly summary: string;
  readonly detail: string;
  readonly evidence: ReadonlyArray<{ threadId: string; messageId: string; excerpt: string }>;
  readonly exchanges?: ReadonlyArray<{ id: string; at: string; role: string; text: string }>;
  readonly outcome?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disposition?: string;
  readonly readAt?: string | null;
  readonly snoozedUntil?: string | null;
}

interface StoredRun {
  readonly id: string;
  readonly profileId: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly costUsd?: number;
}

const JsonValue = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeUnknownEffect(JsonValue);
const toJson = Schema.encodeSync(JsonValue);

const DEFAULT_TURN_END_COOLDOWN_MS = 600_000;
const RUN_RETENTION_PER_TASK = 200;

const turnEndTaskId = (taskId: string) => `${taskId}:turn-end`;
const historyRunId = (runId: string) => `run:${runId}`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "agent_json"))
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN agent_json TEXT`;
  const tables = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map(
      (row) => row.name,
    ),
  );
  if (!tables.has("monitoring_profiles")) return;

  const profiles = new Map<string, { profile: StoredProfile; taskId: string }>();
  for (const row of yield* sql<{
    id: string;
    task_id: string;
    payload_json: string;
  }>`SELECT id, task_id, payload_json FROM monitoring_profiles`) {
    const profile = (yield* parseJson(row.payload_json)) as StoredProfile;
    const taskId = profile.scheduledTaskId ?? row.task_id;
    profiles.set(row.id, { profile, taskId });
    const agent = toJson({
      type: "review",
      kind: profile.kind ?? "standards",
      rules: profile.rules,
      ...(profile.instructionFiles === undefined
        ? {}
        : { instructionFiles: profile.instructionFiles }),
      ...(profile.includeProjectAgents === undefined
        ? {}
        : { includeProjectAgents: profile.includeProjectAgents }),
      targets: profile.targets,
      delivery: profile.delivery ?? "thread-or-alert",
    });
    // A context review kept a $0.05 cap per run; it is now the automation's budget.
    const budget = profile.kind === "context-review" ? { budget: { maxCostUsd: 0.05 } } : {};
    // json_patch(defaults, existing): a grant the row already has wins over the defaults.
    yield* sql`UPDATE scheduled_tasks SET agent_json = ${agent},
      title = ${profile.turnEnd === undefined ? profile.title : `${profile.title} (scheduled)`},
      grant_json = CASE WHEN ${Object.keys(budget).length === 0 ? 0 : 1}
        THEN json_patch(${toJson(budget)}, coalesce(grant_json, '{}')) ELSE grant_json END
      WHERE task_id = ${taskId}`;
    if (profile.turnEnd === undefined) continue;
    // Turn ends now come from an event trigger: the same review as its own automation.
    const cooldownSeconds = Math.min(
      86_400,
      Math.round((profile.turnEnd.cooldownMs ?? DEFAULT_TURN_END_COOLDOWN_MS) / 1000),
    );
    const schedule = toJson({
      type: "event",
      event: "run_ended",
      ...(profile.turnEnd.allProjects === true ? {} : { projectId: profile.projectId }),
      cooldownSeconds,
    });
    // The watcher listener had no hourly cap, only the per-thread cooldown.
    const twinGrant = toJson({ ...budget, maxRunsPerHour: 120 });
    yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
        project_id, thread_id, workspace_strategy_json, model_selection_json, runtime_mode,
        interaction_mode, created_by, creation_source, created_at, updated_at, next_run_at,
        last_run_at, last_run_status, last_run_error, run_count, thread_mode, agent_json, grant_json)
      SELECT ${turnEndTaskId(taskId)}, ${profile.title}, prompt, enabled, ${schedule},
        project_id, NULL, workspace_strategy_json, model_selection_json, runtime_mode,
        interaction_mode, created_by, creation_source, created_at, updated_at, NULL,
        NULL, 'never', NULL, 0, 'new_thread', agent_json, json_patch(${twinGrant}, coalesce(grant_json, '{}'))
      FROM scheduled_tasks WHERE task_id = ${taskId}
      ON CONFLICT (task_id) DO NOTHING`;
  }

  const notificationsByRun = new Map<string, string[]>();
  for (const row of yield* sql<{
    id: string;
    payload_json: string;
  }>`SELECT id, payload_json FROM monitoring_findings`) {
    const finding = (yield* parseJson(row.payload_json)) as StoredFinding;
    if (finding.taskId !== undefined) continue;
    const owner = finding.profileId === undefined ? undefined : profiles.get(finding.profileId);
    const taskId = owner?.taskId ?? `monitoring:${finding.profileId}`;
    const runId = historyRunId(finding.runId);
    const notificationId = `notification:review:${finding.id}`;
    const {
      profileId: _profileId,
      disposition,
      readAt,
      snoozedUntil,
      ...content
    } = { ...finding, exchanges: finding.exchanges ?? [], outcome: finding.outcome ?? null };
    const closed = disposition === "dismissed" || disposition === "resolved";
    const read = readAt ?? (disposition === "acknowledged" || closed ? finding.updatedAt : null);
    const source = toJson({
      kind: "review",
      scheduledTaskId: taskId,
      runId,
      findingId: finding.id,
    });
    yield* sql`INSERT INTO notifications (id, created_at, updated_at, severity, title, body,
        source_json, thread_id, project_id, read_at, dismissed_at, snoozed_until,
        verification_json, dedupe_key, repeat_count)
      VALUES (${notificationId}, ${finding.createdAt}, ${finding.updatedAt}, 'warning',
        ${reviewNotificationTitle(finding)}, ${reviewNotificationBody(content)}, ${source},
        ${finding.threadId}, ${owner?.profile.projectId ?? null}, ${read},
        ${closed ? finding.updatedAt : null}, ${snoozedUntil ?? null}, NULL,
        ${reviewNotificationDedupeKey(taskId, finding.id)}, 0)
      ON CONFLICT (id) DO NOTHING`;
    notificationsByRun.set(runId, [...(notificationsByRun.get(runId) ?? []), notificationId]);
    const payload = toJson({ ...content, taskId, runId });
    yield* sql`UPDATE monitoring_findings SET profile_id = ${taskId}, payload_json = ${payload}
      WHERE id = ${row.id}`;
  }

  for (const row of yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM monitoring_runs`) {
    const run = (yield* parseJson(row.payload_json)) as StoredRun;
    const taskId = profiles.get(run.profileId)?.taskId ?? `monitoring:${run.profileId}`;
    const id = historyRunId(run.id);
    const notifications = notificationsByRun.get(id) ?? [];
    const status =
      run.status === "succeeded" ? (notifications.length > 0 ? "notified" : "quiet") : "failed";
    const error =
      run.status === "running" ? "The server stopped before this review finished." : run.error;
    yield* sql`INSERT INTO scheduled_task_runs (id, task_id, started_at, ended_at, status,
        trigger_json, cost_usd, notification_ids_json, error)
      SELECT ${id}, ${taskId}, ${run.startedAt}, ${run.completedAt ?? run.startedAt}, ${status},
        ${toJson({ type: "schedule", summary: "Watcher review" })}, ${run.costUsd ?? null},
        ${toJson(notifications)}, ${error}
      WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${taskId})
      ON CONFLICT (id) DO NOTHING`;
  }
  yield* sql`DELETE FROM scheduled_task_runs WHERE id IN (
    SELECT id FROM (
      SELECT id, row_number() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rank
      FROM scheduled_task_runs WHERE status != 'skipped'
    ) WHERE rank > ${RUN_RETENTION_PER_TASK})`;
  yield* sql`UPDATE scheduled_tasks SET last_run_ended_at = (
      SELECT max(ended_at) FROM scheduled_task_runs r WHERE r.task_id = scheduled_tasks.task_id)
    WHERE agent_json IS NOT NULL AND last_run_ended_at IS NULL`;
  yield* sql`DROP TABLE monitoring_runs`;
  yield* sql`DROP TABLE monitoring_profiles`;
});
