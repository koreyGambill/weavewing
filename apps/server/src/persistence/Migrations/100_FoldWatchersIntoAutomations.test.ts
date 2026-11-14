import { MonitoringFinding, ScheduledTaskAgent, ScheduledTaskSchedule } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0100 from "./100_FoldWatchersIntoAutomations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const decodeAgent = Schema.decodeUnknownSync(Schema.fromJsonString(ScheduledTaskAgent));
const decodeSchedule = Schema.decodeUnknownSync(Schema.fromJsonString(ScheduledTaskSchedule));
const decodeFinding = Schema.decodeUnknownSync(Schema.fromJsonString(MonitoringFinding));

const model = { instanceId: "claudeAgent", model: "claude-haiku-4-5" };
const targets = {
  state: "active",
  threadIds: ["thread-a"],
  includeChildren: true,
  minAgeMs: 0,
  updatedWithinMs: 86_400_000,
};
const rule = { id: "rule-1", title: "Use Sparkwing", instructions: "Land through Sparkwing." };
const at = "2026-11-10T10:00:00.000Z";

const profile = (id: string, fields: Record<string, unknown>) => ({
  id,
  title: `Watcher ${id}`,
  enabled: true,
  projectId: "project-1",
  modelSelection: model,
  schedule: { type: "interval", everyMs: 3_600_000 },
  targets,
  rules: [rule],
  scheduledTaskId: `monitoring:${id}`,
  createdAt: at,
  updatedAt: at,
  ...fields,
});

const finding = (
  id: string,
  profileId: string,
  runId: string,
  fields: Record<string, unknown>,
) => ({
  id,
  profileId,
  runId,
  threadId: "thread-a",
  ruleId: "rule-1",
  ruleSnapshot: rule,
  summary: `Finding ${id}`,
  detail: "The land ran from bash.",
  confidence: 0.9,
  evidence: [{ threadId: "thread-a", messageId: "message-1", excerpt: "git merge" }],
  createdAt: at,
  updatedAt: "2026-11-11T10:00:00.000Z",
  disposition: "open",
  readAt: null,
  snoozedUntil: null,
  exchanges: [],
  outcome: null,
  ...fields,
});

layer("100_FoldWatchersIntoAutomations", (it) => {
  it.effect("folds watcher profiles, findings and runs into automations, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });
      const task = (id: string, enabled: boolean, schedule: unknown) => sql`
        INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
          thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
          created_by, creation_source, created_at, updated_at, next_run_at, last_run_at,
          last_run_status, last_run_error, run_count, thread_mode)
        VALUES (${id}, 'stale title', 'Read-only standards monitoring', ${enabled ? 1 : 0},
          ${JSON.stringify(schedule)}, 'project-1', NULL, '{"type":"root"}',
          ${JSON.stringify(model)}, 'approval-required', 'default', 'system', 'server', ${at}, ${at},
          '2026-11-15T09:00:00.000Z', ${at}, 'succeeded', NULL, 7, 'new_thread')`;
      const both = profile("both", { turnEnd: { cooldownMs: 900_000 } });
      const alerts = profile("alerts", {
        delivery: "alerts",
        schedule: { type: "fixed_time", timeOfDay: "07:00" },
        instructionFiles: ["~/AGENTS.md"],
      });
      const context = profile("context", {
        kind: "context-review",
        enabled: false,
        turnEnd: { allProjects: true },
        includeProjectAgents: true,
      });
      for (const entry of [both, alerts, context]) {
        yield* task(entry.scheduledTaskId, entry.enabled, entry.schedule);
        yield* sql`INSERT INTO monitoring_profiles (id, task_id, payload_json)
          VALUES (${entry.id}, ${entry.scheduledTaskId}, ${JSON.stringify(entry)})`;
      }
      const findings = [
        finding("open", "both", "run-1", {}),
        finding("read", "both", "run-1", { readAt: "2026-11-10T11:00:00.000Z" }),
        finding("snoozed", "both", "run-1", { snoozedUntil: "2026-11-20T09:00:00.000Z" }),
        finding("dismissed", "both", "run-1", { disposition: "dismissed" }),
        finding("resolved", "alerts", "run-3", { disposition: "resolved", outcome: "corrected" }),
        finding("acknowledged", "alerts", "run-3", { disposition: "acknowledged" }),
      ];
      for (const entry of findings)
        yield* sql`INSERT INTO monitoring_findings (id, profile_id, thread_id, updated_at, payload_json)
          VALUES (${entry.id}, ${entry.profileId}, ${entry.threadId}, ${entry.updatedAt},
            ${JSON.stringify(entry)})`;
      const run = (id: string, profileId: string, status: string, fields = {}) => ({
        id,
        profileId,
        startedAt: at,
        completedAt: status === "running" ? null : at,
        status,
        error: status === "failed" ? "Model unavailable" : null,
        targetThreadIds: [],
        profile: both,
        ...fields,
      });
      for (const entry of [
        run("run-1", "both", "succeeded", { costUsd: 0.01 }),
        run("run-2", "both", "succeeded"),
        run("run-3", "alerts", "succeeded"),
        run("run-4", "context", "failed", { costUsd: 0.04, budgetUsd: 0.05 }),
        run("run-5", "context", "running"),
      ])
        yield* sql`INSERT INTO monitoring_runs (id, profile_id, started_at, payload_json)
          VALUES (${entry.id}, ${entry.profileId}, ${entry.startedAt}, ${JSON.stringify(entry)})`;

      yield* runMigrations();

      const tasks = yield* sql<{
        task_id: string;
        title: string;
        enabled: number;
        schedule_json: string;
        agent_json: string | null;
        run_count: number;
        next_run_at: string | null;
      }>`SELECT task_id, title, enabled, schedule_json, agent_json, run_count, next_run_at
        FROM scheduled_tasks ORDER BY task_id`;
      assert.deepEqual(
        tasks.map((row) => [row.task_id, row.title, row.enabled, row.run_count]),
        [
          ["monitoring:alerts", "Watcher alerts", 1, 7],
          ["monitoring:both", "Watcher both (scheduled)", 1, 7],
          ["monitoring:both:turn-end", "Watcher both", 1, 0],
          ["monitoring:context", "Watcher context (scheduled)", 0, 7],
          ["monitoring:context:turn-end", "Watcher context", 0, 0],
        ],
      );
      const byId = new Map(tasks.map((row) => [row.task_id, row]));
      assert.deepEqual(decodeAgent(byId.get("monitoring:alerts")!.agent_json), {
        type: "review",
        kind: "standards",
        rules: [rule],
        instructionFiles: ["~/AGENTS.md"],
        targets,
        delivery: "alerts",
      } as never);
      assert.deepEqual(
        decodeAgent(byId.get("monitoring:context:turn-end")!.agent_json),
        decodeAgent(byId.get("monitoring:context")!.agent_json),
      );
      assert.strictEqual(byId.get("monitoring:both")!.next_run_at, "2026-11-15T09:00:00.000Z");
      assert.deepEqual(decodeSchedule(byId.get("monitoring:both:turn-end")!.schedule_json), {
        type: "event",
        event: "run_ended",
        projectId: "project-1",
        cooldownSeconds: 900,
        maxRunsPerHour: 120,
      } as never);
      assert.deepEqual(decodeSchedule(byId.get("monitoring:context:turn-end")!.schedule_json), {
        type: "event",
        event: "run_ended",
        cooldownSeconds: 600,
        maxRunsPerHour: 120,
      } as never);

      const notifications = yield* sql<{
        id: string;
        severity: string;
        title: string;
        body: string;
        source_json: string;
        thread_id: string;
        project_id: string;
        read_at: string | null;
        dismissed_at: string | null;
        snoozed_until: string | null;
      }>`SELECT * FROM notifications ORDER BY id`;
      assert.deepEqual(
        notifications.map((row) => [row.id, row.read_at, row.dismissed_at, row.snoozed_until]),
        [
          ["notification:review:acknowledged", "2026-11-11T10:00:00.000Z", null, null],
          [
            "notification:review:dismissed",
            "2026-11-11T10:00:00.000Z",
            "2026-11-11T10:00:00.000Z",
            null,
          ],
          ["notification:review:open", null, null, null],
          ["notification:review:read", "2026-11-10T11:00:00.000Z", null, null],
          [
            "notification:review:resolved",
            "2026-11-11T10:00:00.000Z",
            "2026-11-11T10:00:00.000Z",
            null,
          ],
          ["notification:review:snoozed", null, null, "2026-11-20T09:00:00.000Z"],
        ],
      );
      const open = notifications.find((row) => row.id === "notification:review:open")!;
      assert.deepEqual(
        [open.severity, open.title, open.thread_id, open.project_id, JSON.parse(open.source_json)],
        [
          "warning",
          "Finding open",
          "thread-a",
          "project-1",
          {
            kind: "review",
            scheduledTaskId: "monitoring:both",
            runId: "run:run-1",
            findingId: "open",
          },
        ],
      );
      assert.include(open.body, "The land ran from bash.");
      assert.include(open.body, "git merge");
      assert.include(
        notifications.find((row) => row.id === "notification:review:resolved")!.body,
        "**Outcome:** Corrected",
      );

      const stored = yield* sql<{ profile_id: string; payload_json: string }>`
        SELECT profile_id, payload_json FROM monitoring_findings WHERE id = 'snoozed'`;
      const migrated = decodeFinding(stored[0]!.payload_json);
      assert.strictEqual(stored[0]!.profile_id, "monitoring:both");
      assert.deepEqual([migrated.taskId, migrated.runId], ["monitoring:both", "run:run-1"]);
      assert.notProperty(JSON.parse(stored[0]!.payload_json), "disposition");

      const runs = yield* sql<{
        id: string;
        task_id: string;
        status: string;
        cost_usd: number | null;
        notification_ids_json: string;
        error: string | null;
      }>`SELECT id, task_id, status, cost_usd, notification_ids_json, error
        FROM scheduled_task_runs ORDER BY id`;
      assert.deepEqual(
        runs.map((row) => [row.id, row.task_id, row.status, row.cost_usd, row.error]),
        [
          ["run:run-1", "monitoring:both", "notified", 0.01, null],
          ["run:run-2", "monitoring:both", "quiet", null, null],
          ["run:run-3", "monitoring:alerts", "notified", null, null],
          ["run:run-4", "monitoring:context", "failed", 0.04, "Model unavailable"],
          [
            "run:run-5",
            "monitoring:context",
            "failed",
            null,
            "The server stopped before this review finished.",
          ],
        ],
      );
      assert.deepEqual(JSON.parse(runs[0]!.notification_ids_json), [
        "notification:review:open",
        "notification:review:read",
        "notification:review:snoozed",
        "notification:review:dismissed",
      ]);
      const left = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('monitoring_profiles', 'monitoring_runs', 'monitoring_findings')`;
      assert.deepEqual(
        left.map((row) => row.name),
        ["monitoring_findings"],
      );

      const snapshot = () =>
        Effect.all([
          sql`SELECT * FROM scheduled_tasks ORDER BY task_id`,
          sql`SELECT * FROM notifications ORDER BY id`,
          sql`SELECT * FROM scheduled_task_runs ORDER BY id`,
          sql`SELECT * FROM monitoring_findings ORDER BY id`,
        ]);
      const before = yield* snapshot();
      yield* Migration0100;
      assert.deepEqual(yield* snapshot(), before);
    }),
  );
});
