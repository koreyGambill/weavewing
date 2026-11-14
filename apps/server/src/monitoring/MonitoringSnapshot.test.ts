import * as ContextRecords from "../threadInsights/ContextRecords.ts";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  RunId,
  MessageId,
  type MonitoringReviewOutput,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Snapshot from "./MonitoringSnapshot.ts";
import type { ReviewProfile } from "./ReviewProfile.ts";
const at = "1970-01-01T00:00:00.000Z";
const profile: ReviewProfile = {
  id: ScheduledTaskId.make("monitoring:p"),
  kind: "standards",
  turnEnd: false,
  delivery: "thread-or-alert",
  title: "Watcher",
  enabled: true,
  projectId: ProjectId.make("project"),
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "haiku" },
  targets: {
    state: "active",
    threadIds: [ThreadId.make("chosen")],
    includeChildren: true,
    minAgeMs: 0,
    updatedWithinMs: null,
  },
  rules: [{ id: "r", title: "Rule", instructions: "Evidence" }],
};
it.effect(
  "decodes persisted ISO timestamps, selects explicit threads and validates observed evidence",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const id of ["chosen", "excluded"]) {
        const payload = JSON.stringify({
          id,
          projectId: "project",
          title: id,
          providerInstanceId: "claude",
          modelSelection: { instanceId: "claude", model: "haiku" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        });
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},'project',${id},'claude','full-access','default',${at},${at},${payload})`;
        for (const streaming of [false, true]) {
          const mid = id + (streaming ? ":stream" : ":done");
          const message = JSON.stringify({
            id: mid,
            threadId: id,
            runId: null,
            nodeId: null,
            role: "assistant",
            text: streaming ? "partial" : "Tests 3 passed",
            attachments: [],
            streaming,
            createdAt: at,
            updatedAt: at,
            createdBy: "agent",
            creationSource: "server",
          });
          yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES (${mid},${id},'assistant',${streaming ? 1 : 0},${at},${at},${message})`;
        }
      }
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/workspace/project','[]',${at},${at})`;
      const before = yield* sql`SELECT count(*) AS count FROM orchestration_v2_projection_messages`;
      const snap = yield* (yield* Snapshot.MonitoringSnapshot).capture(profile);
      assert.deepEqual(
        snap.threads.map((t) => t.id),
        ["chosen"],
      );
      assert.deepEqual(
        snap.threads[0]?.messages.map((m) => m.text),
        ["Tests 3 passed"],
      );
      assert.equal(snap.truncated, false);
      const exact = yield* (yield* Snapshot.MonitoringSnapshot).capture(
        {
          ...profile,
          includeProjectAgents: true,
          targets: { ...profile.targets, state: "closed", minAgeMs: 60_000 },
        },
        ThreadId.make("excluded"),
      );
      assert.deepEqual(
        exact.threads.map((thread) => thread.id),
        ["excluded"],
      );
      assert.equal(exact.projectRoot, "/workspace/project");
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at=${at} WHERE thread_id='excluded'`;
      assert.deepEqual(
        (yield* (yield* Snapshot.MonitoringSnapshot).capture(profile, ThreadId.make("excluded")))
          .threads,
        [],
      );
      const context = yield* (yield* Snapshot.MonitoringSnapshot).capture({
        ...profile,
        kind: "context-review",
      });
      assert.equal(context.threads[0]?.messages[0]?.id, "context:run");
      assert.equal(context.newestContextAt, at);
      const completedAt = "1970-01-01T00:00:01.000Z";
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES ('run','chosen',1,'claude','completed',${at},${completedAt},'{}')`;
      const completedContext = yield* (yield* Snapshot.MonitoringSnapshot).capture({
        ...profile,
        kind: "context-review",
      });
      assert.equal(completedContext.newestContextAt, completedAt);
      assert.include(context.threads[0]?.messages[0]?.text ?? "", '"repeatedReads":5');
      assert.notInclude(context.threads[0]?.messages[0]?.text ?? "", "Tests 3 passed");
      assert.equal(
        Snapshot.validateMonitoringEvidence(
          {
            findings: [
              {
                ruleId: "r",
                threadId: ThreadId.make("chosen"),
                summary: "Repeated reads",
                detail: "Consider a summary",
                confidence: 0.6,
                evidence: [
                  {
                    threadId: ThreadId.make("chosen"),
                    messageId: MessageId.make("context:run"),
                    excerpt: '"repeatedReads":5',
                  },
                ],
              },
            ],
          },
          profile,
          context,
        ),
        true,
      );
      assert.include(snap.coverage, "files were not inspected");
      assert.deepEqual(
        yield* sql`SELECT count(*) AS count FROM orchestration_v2_projection_messages`,
        before,
      );
      const finding: MonitoringReviewOutput["findings"][number] = {
        ruleId: "r",
        threadId: ThreadId.make("chosen"),
        summary: "Missing evidence",
        detail: "Observed",
        confidence: 0.8,
        evidence: [
          {
            threadId: ThreadId.make("chosen"),
            messageId: MessageId.make("chosen:done"),
            excerpt: "Tests 3 passed",
          },
        ],
      };
      assert.equal(
        Snapshot.validateMonitoringEvidence({ findings: [finding] }, profile, snap),
        true,
      );
      assert.equal(
        Snapshot.validateMonitoringEvidence(
          {
            findings: [
              { ...finding, evidence: [{ ...finding.evidence[0]!, excerpt: "not observed" }] },
            ],
          },
          profile,
          snap,
        ),
        false,
      );
      assert.equal(
        Snapshot.validateMonitoringEvidence(
          { findings: [{ ...finding, ruleId: "unknown" }] },
          profile,
          snap,
        ),
        false,
      );
    }).pipe(
      Effect.provide(
        Snapshot.layer.pipe(
          Layer.provide(
            Layer.mock(ContextRecords.ContextRecords)({
              get: ({ threadId }) =>
                Effect.succeed({
                  threadId,
                  records: [
                    {
                      runId: RunId.make("run"),
                      ordinal: 1,
                      model: "haiku",
                      providerInstanceId: ProviderInstanceId.make("claude"),
                      startedAt: at,
                      status: "completed",
                      cachedInputTokensStatus: "unavailable",
                      instructions: [],
                      reads: [],
                      repeatedReads: 5,
                      inputTokens: null,
                      cachedInputTokens: null,
                      outputTokens: null,
                      usageStatus: "unavailable",
                      truncated: false,
                    },
                  ],
                  nextBeforeOrdinal: null,
                  coverage: "Fixture context records",
                }),
            }),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect("windows a turn-end snapshot to messages after each thread's watermark", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const time = (second: number) => `1970-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
    for (const id of ["root", "busy"]) {
      const payload = JSON.stringify({
        id,
        projectId: "project",
        title: id,
        providerInstanceId: "claude",
        modelSelection: { instanceId: "claude", model: "haiku" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},'project',${id},'claude','full-access','default',${at},${at},${payload})`;
    }
    const message = (threadId: string, id: string, second: number, streaming = false) => {
      const payload = JSON.stringify({
        id,
        threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: `text ${id}`,
        attachments: [],
        streaming,
        createdAt: time(second),
        updatedAt: time(second),
        createdBy: "agent",
        creationSource: "server",
      });
      return sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES (${id},${threadId},'assistant',${streaming ? 1 : 0},${time(second)},${time(second)},${payload})`;
    };
    for (const [id, second] of [
      ["root:1", 1],
      ["root:2", 2],
      ["root:3a", 3],
      ["root:3b", 3],
      ["root:4", 4],
      ["root:6", 6],
    ] as const)
      yield* message("root", id, second);
    yield* message("root", "root:5", 5, true);
    for (let second = 1; second <= 45; second++)
      yield* message("busy", `busy:${String(second).padStart(2, "0")}`, second);
    const snapshots = yield* Snapshot.MonitoringSnapshot;
    const turnEnd = { ...profile, targets: { ...profile.targets, threadIds: [] } };
    const mark = (id: string, second: number) => ({ createdAt: time(second), messageId: id });
    const labels = (snapshot: Snapshot.MonitoringSnapshotData) =>
      snapshot.threads.map((thread) =>
        thread.messages.map((m) => `${m.id}${m.priorContext ? " (context)" : ""}`),
      );
    // A message sharing the mark's timestamp is new; one still streaming holds back what follows it.
    const windowed = yield* snapshots.capture(turnEnd, ThreadId.make("root"), {
      root: mark("root:3a", 3),
    });
    assert.deepEqual(labels(windowed), [
      ["root:2 (context)", "root:3a (context)", "root:3b", "root:4"],
    ]);
    assert.deepEqual(windowed.reviewedThrough, { root: mark("root:4", 4) });
    const caughtUp = yield* snapshots.capture(turnEnd, ThreadId.make("root"), {
      root: mark("root:4", 4),
    });
    assert.isTrue(caughtUp.threads[0]?.messages.every((m) => m.priorContext));
    assert.deepEqual(caughtUp.reviewedThrough, { root: mark("root:4", 4) });
    // Past 40 new messages, the oldest 40 are reviewed and the rest wait for the next window.
    const backlog = yield* snapshots.capture(turnEnd, ThreadId.make("busy"), {
      busy: mark("busy:01", 1),
    });
    assert.equal(backlog.threads[0]?.messages.filter((m) => !m.priorContext)[0]?.id, "busy:02");
    assert.deepEqual(backlog.reviewedThrough, { busy: mark("busy:41", 41) });
    assert.isTrue(backlog.truncated);
    const full = yield* snapshots.capture(turnEnd, ThreadId.make("root"));
    assert.equal(full.reviewedThrough, undefined);
    assert.deepEqual(
      full.threads.map((thread) => thread.messages.length),
      [6],
    );
  }).pipe(
    Effect.provide(
      Snapshot.layer.pipe(
        Layer.provide(Layer.mock(ContextRecords.ContextRecords)({})),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);
