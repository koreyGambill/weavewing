import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskRunId,
  type ScheduledTaskUpsertInput,
  SecretRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as UsageService from "../usage/UsageService.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);

const threadShell = (
  projectId: ProjectId,
  state: { archivedAt?: string | null; deletedAt?: string | null } = {},
) => ({ projectId, archivedAt: null, deletedAt: null, ...state }) as never;

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      // A run the previous process marked running but never dispatched.
      yield* sql`INSERT INTO scheduled_task_runs (id, task_id, started_at, status, trigger_json)
        VALUES ('run:stuck', 'stuck-valid', ${now}, 'running', '{"type":"schedule","summary":""}')`;
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  streamDomainEvents: Stream.empty,
                  streamDomainEventsFrom: () => Stream.empty,
                  latestDomainEventSequence: Effect.succeed(0),
                }),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
      const history = yield* sql<{
        task_id: string;
        status: string;
        ended_at: string | null;
        error: string | null;
      }>`SELECT task_id, status, ended_at, error FROM scheduled_task_runs ORDER BY task_id`;
      const stuckRun = history.find((run) => run.task_id === "stuck-valid");
      assert.equal(stuckRun?.status, "failed");
      assert.equal(stuckRun?.error, "Run was interrupted by a server restart.");
      assert.isNotNull(stuckRun?.ended_at);
      // Each dispatch that failed closed its own history row.
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const run = history.find((candidate) => candidate.task_id === id);
        assert.equal(run?.status, "failed");
        assert.isTrue(run?.error?.includes("test launch failure") === true);
      }
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  streamDomainEvents: Stream.empty,
                  streamDomainEventsFrom: () => Stream.empty,
                  latestDomainEventSequence: Effect.succeed(0),
                }),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(refused.message, "Schedule task is already running.");
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { status: "failed", error: "Weekly usage limit reached" },
  { status: "interrupted", error: "The run was stopped." },
  { status: "cancelled", error: "The run was cancelled." },
] as const)("a run that ends $status after its message was accepted records it", (outcome) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:test");
    const ended = yield* Deferred.make<void>();
    const sent = yield* Ref.make("");
    const sentText = yield* Ref.make("");
    const run = { id: "run:2", status: outcome.status, rootNodeId: "node:root" };
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.set(sent, input.messageId).pipe(
                Effect.andThen(Ref.set(sentText, input.text)),
                Effect.as({} as never),
              ),
            getThreadShell: () => Effect.succeed(threadShell(projectId)),
            getProjectThreadRecords: () =>
              Effect.map(
                Ref.get(sent),
                (userMessageId) =>
                  ({
                    runs: [
                      { id: "run:1", status: "completed", userMessageId: "message:earlier" },
                      { ...run, userMessageId },
                    ],
                    messages: [{ id: userMessageId, runId: "run:2" }],
                    turnItems: [
                      {
                        type: "error",
                        status: "failed",
                        runId: "run:2",
                        nodeId: "node:root",
                        failure: { message: "Weekly usage limit reached" },
                      },
                    ],
                  }) as never,
              ),
            waitForThread: (input) =>
              Deferred.await(ended).pipe(
                Effect.as({
                  threadId: input.threadId,
                  run: { ...run, id: input.runId, userMessageId: "" },
                  timedOut: false,
                } as never),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:quota"),
        title: "Quota bookkeeping",
        prompt: "Update the notes",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: ThreadId.make("thread:quota"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id });
      const failed = yield* service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((candidate) => candidate.id === task.id)),
        Stream.filter((current) => current?.lastRunStatus === "failed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(ended, undefined);
      const recorded = Option.getOrUndefined(yield* Fiber.join(failed));
      assert.equal(recorded?.lastRunError, outcome.error);
      assert.equal(recorded?.runCount, 1);
      const { runs } = yield* service.listRuns({ id: task.id });
      assert.lengthOf(runs, 1);
      assert.deepInclude(runs[0], {
        status: "failed",
        error: outcome.error,
        trigger: { type: "manual", summary: "Run now" },
        threadId: ThreadId.make("thread:quota"),
        messageId: MessageId.make(yield* Ref.get(sent)),
      });
      assert.isNotNull(runs[0]?.endedAt);
      // A bound thread is a conversation the user is in, so it gets no preface.
      assert.equal(yield* Ref.get(sentText), "Update the notes");
      const sql = yield* SqlClient.SqlClient;
      const [bound] = yield* sql<{
        orchestration_run_id: string;
      }>`SELECT orchestration_run_id FROM scheduled_task_runs`;
      assert.equal(bound?.orchestration_run_id, "run:2");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a completed run closes its history as quiet with its tokens and cost", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:test");
    const threadId = ThreadId.make("thread:usage");
    const ended = yield* Deferred.make<void>();
    const launchedMessage = yield* Ref.make("");
    const launchedText = yield* Ref.make("");
    // The run's turn, and a later run's turn in the same thread that it must not count.
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
      VALUES ('attempt:1', ${threadId}, 'run:usage', 1, 'node:root', 'claude', 'pt:1', 'completed', '{}'),
             ('attempt:2', ${threadId}, 'run:later', 1, 'node:root', 'claude', 'pt:1', 'completed', '{}')`;
    const usage = (input: number, output: number) =>
      JSON.stringify({
        model: "claude-haiku-4-5",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: true,
          inputTokens: input,
          cachedInputTokens: 400,
          outputTokens: output,
          otherUsage: { inputTokens: 300, outputTokens: 100 },
        },
      });
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, payload_json)
      VALUES ('turn:1', ${threadId}, 'pt:1', 'node:root', 'attempt:1', 1, 'completed', ${usage(1000, 200)}),
             ('turn:2', ${threadId}, 'pt:1', 'node:root', 'attempt:2', 2, 'completed', ${usage(9000, 9000)})`;
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Ref.set(launchedMessage, input.initialMessage?.messageId ?? "").pipe(
                Effect.andThen(Ref.set(launchedText, input.initialMessage?.text ?? "")),
                Effect.as({ threadId, resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(threadShell(projectId)),
            getProjectThreadRecords: () =>
              Effect.map(
                Ref.get(launchedMessage),
                (userMessageId) =>
                  ({ runs: [{ id: "run:usage", status: "running", userMessageId }] }) as never,
              ),
            waitForThread: (input) =>
              Deferred.await(ended).pipe(
                Effect.as({
                  threadId: input.threadId,
                  run: { id: input.runId, status: "completed", completedAt: null },
                  timedOut: false,
                } as never),
              ),
          }),
          Layer.mock(UsageService.UsageService)({
            priceRecords: (records) =>
              Effect.succeed(
                records.reduce((sum, record) => sum + record.totals.outputTokens / 1000, 0),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:usage"),
        title: "Exposure check",
        prompt: "Check exposure",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "haiku" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id }, { byAgent: true });
      const running = yield* service.listRuns({ id: task.id });
      assert.equal(running.runs[0]?.status, "running");
      assert.equal(running.runs[0]?.threadId, threadId);
      // Each list emission re-reads the runs, so the first read already sees a close that won.
      const closed = yield* service.subscribeList().pipe(
        Stream.mapEffect(() => service.listRuns({ id: task.id })),
        Stream.filter(({ runs }) => runs[0]?.status === "quiet"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(ended, undefined);
      const { runs, hasMore } = Option.getOrThrow(yield* Fiber.join(closed));
      assert.isFalse(hasMore);
      assert.lengthOf(runs, 1);
      assert.deepInclude(runs[0], {
        status: "quiet",
        trigger: { type: "agent", summary: "Run by an agent" },
        threadId,
        tokens: 1000 + 200,
        costUsd: 0.2,
        otherTokens: 300 + 100,
        otherCostUsdEstimate: 0.1,
        error: null,
      });
      assert.isNotNull(runs[0]?.endedAt);
      const [listed] = (yield* service.list()).tasks;
      assert.equal(listed?.lastRunEndedAt, runs[0]?.endedAt);
      assert.equal(
        yield* Ref.get(launchedText),
        '[Automated run of "Exposure check" (Run by an agent). Nobody is watching live; use t3_notify for anything the user must see.]\n\nCheck exposure',
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const followerLayer = (input: {
  readonly ended: Deferred.Deferred<void>;
  readonly sentMessage: Ref.Ref<string>;
  readonly launch?: ThreadLaunchService.ThreadLaunchService["Service"]["launch"];
}) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)(
          input.launch === undefined ? {} : { launch: input.launch },
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          getProjectThreadRecords: () =>
            Effect.map(
              Ref.get(input.sentMessage),
              (userMessageId) =>
                ({ runs: [{ id: "run:followed", status: "running", userMessageId }] }) as never,
            ),
          waitForThread: (wait) =>
            Deferred.await(input.ended).pipe(
              Effect.as({
                threadId: wait.threadId,
                run: { id: wait.runId, status: "completed", completedAt: null },
                timedOut: false,
              } as never),
            ),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );

const awaitRunStatus = (taskId: ScheduledTaskId, status: string) =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    // Each list emission re-reads the runs, so the first read already sees a close that won.
    return yield* service.subscribeList().pipe(
      Stream.mapEffect(() => service.listRuns({ id: taskId })),
      Stream.filter(({ runs }) => runs[0]?.status === status),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.forkChild,
    );
  });

it.effect("a sent run left open by a previous process is followed to its outcome", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertRow(sql, { id: "task:followed", next: null, enabled: 1, status: "failed" }, now);
    yield* sql`INSERT INTO scheduled_task_runs
      (id, task_id, started_at, status, trigger_json, thread_id, message_id)
      VALUES ('run:open', 'task:followed', ${now}, 'running', '{"type":"schedule","summary":""}',
        'thread:followed', 'message:followed')`;
    const ended = yield* Deferred.make<void>();
    const sentMessage = yield* Ref.make("message:followed");
    yield* Effect.gen(function* () {
      const closed = yield* awaitRunStatus(ScheduledTaskId.make("task:followed"), "quiet");
      yield* Deferred.succeed(ended, undefined);
      const { runs } = yield* Fiber.join(closed);
      assert.deepInclude(runs[0], {
        id: ScheduledTaskRunId.make("run:open"),
        status: "quiet",
        threadId: ThreadId.make("thread:followed"),
        error: null,
      });
      const [bound] = yield* sql<{
        orchestration_run_id: string;
      }>`SELECT orchestration_run_id FROM scheduled_task_runs`;
      assert.equal(bound?.orchestration_run_id, "run:followed");
    }).pipe(Effect.provide(followerLayer({ ended, sentMessage })));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a sent run stays open for its follower when only the completion record fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ended = yield* Deferred.make<void>();
    const taskId = ScheduledTaskId.make("task:record-fails");
    const sentMessage = yield* Ref.make("");
    const layer = followerLayer({
      ended,
      sentMessage,
      // Corrupt the row while the turn is sent, so recording the completion fails.
      launch: (launch) =>
        sql`UPDATE scheduled_tasks SET schedule_json = 'broken' WHERE task_id = ${taskId}`.pipe(
          Effect.orDie,
          Effect.andThen(Ref.set(sentMessage, launch.initialMessage?.messageId ?? "")),
          Effect.as({ threadId: ThreadId.make("thread:followed"), resumed: false } as never),
        ),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({
        id: taskId,
        title: "Check",
        prompt: "Check",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* Effect.flip(service.runNow({ id: taskId }));
      const [open] = yield* sql<{
        ended_at: string | null;
        thread_id: string | null;
      }>`SELECT ended_at, thread_id FROM scheduled_task_runs`;
      assert.isNull(open?.ended_at);
      assert.equal(open?.thread_id, "thread:followed");
      yield* sql`UPDATE scheduled_tasks SET schedule_json = '{"type":"interval","everyMs":60000}'`;
      const closed = yield* awaitRunStatus(taskId, "quiet");
      yield* Deferred.succeed(ended, undefined);
      yield* Fiber.join(closed);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run whose dispatch fails is recorded as failed without a thread", () =>
  Effect.gen(function* () {
    const launchedText = yield* Ref.make("");
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Ref.set(launchedText, input.initialMessage?.text ?? "").pipe(
                Effect.andThen(Effect.die(new Error("provider unavailable"))),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:dispatch-fails"),
        title: "Check",
        prompt: "Check",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const result = yield* service.runNow({ id: task.id });
      assert.isNull(result.threadId);
      const { runs } = yield* service.listRuns({ id: task.id });
      assert.lengthOf(runs, 1);
      assert.equal(runs[0]?.status, "failed");
      assert.isNull(runs[0]?.threadId);
      assert.isNotNull(runs[0]?.endedAt);
      assert.isTrue(runs[0]?.error?.includes("provider unavailable") === true);
      // A new thread gets the preface; a person pressed Run now, so it does not say nobody watches.
      assert.equal(
        yield* Ref.get(launchedText),
        '[Automated run of "Check" (Run now). Use t3_notify for anything the user must see.]\n\nCheck',
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a bound run follows its thread when promotion moves it mid-send", () =>
  Effect.gen(function* () {
    const scratch = ProjectId.make("project:scratch");
    const promoted = ProjectId.make("project:promoted");
    const sends = yield* Ref.make<Array<{ projectId: ProjectId; commandId: string }>>([]);
    // Saving reads it first. Then the rebind lands, and the promotion commits between the shell
    // read and the retry.
    const shellProjects = yield* Ref.make([promoted, scratch, promoted]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            sendToThread: (input) =>
              Ref.updateAndGet(sends, (all) => [
                ...all,
                { projectId: input.projectId, commandId: input.commandId },
              ]).pipe(
                Effect.flatMap((all) =>
                  all.length < 3
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed({} as never),
                ),
              ),
            getThreadShell: () =>
              Ref.modify(shellProjects, ([next, ...rest]) => [threadShell(next ?? promoted), rest]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:promoted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:promoted-during-run"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: promoted,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const result = yield* service.runNow({ id: task.id });

      assert.equal(result.threadId, threadId);
      const attempts = yield* Ref.get(sends);
      assert.deepEqual(
        attempts.map((attempt) => attempt.projectId),
        [promoted, scratch, promoted],
      );
      assert.equal(new Set(attempts.map((attempt) => attempt.commandId)).size, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a fresh-session task launches one thread, then starts each later run fresh in it", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const sends = yield* Ref.make<
      Array<{ threadId: ThreadId; freshContext?: boolean; model?: string }>
    >([]);
    const launched = ThreadId.make("thread:fresh-session-task");
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: launched, resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            getThreadShell: () => Effect.succeed({ deletedAt: null } as never),
            sendToThread: (input) =>
              Ref.update(sends, (all) => [
                ...all,
                {
                  threadId: input.threadId,
                  ...(input.freshContext === undefined ? {} : { freshContext: input.freshContext }),
                  ...(input.modelSelection === undefined
                    ? {}
                    : { model: input.modelSelection.model }),
                },
              ]).pipe(Effect.as({} as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = {
        id: ScheduledTaskId.make("task:fresh-session"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({ ...input, threadMode: "fresh_session" });

      assert.equal((yield* service.runNow({ id: input.id })).threadId, launched);
      // A form opened before the first run saves no thread; the binding stays.
      const { task } = yield* service.upsert({
        ...input,
        threadId: null,
        threadMode: "fresh_session",
      });
      assert.equal(task.threadId, launched);
      assert.equal(task.threadMode, "fresh_session");
      // A client that predates thread modes sends neither; both stay.
      const legacy = yield* service.upsert({ ...input, threadId: null });
      assert.equal(legacy.task.threadId, launched);
      assert.equal(legacy.task.threadMode, "fresh_session");
      yield* service.runNow({ id: input.id });

      assert.equal(yield* Ref.get(launches), 1);
      // The run uses the task's model, not whatever the thread was switched to.
      assert.deepEqual(yield* Ref.get(sends), [
        { threadId: launched, freshContext: true, model: "gpt-5.4" },
      ]);
      // Its thread stays in the old project, so moving the task leaves it for a new one.
      const moved = yield* service.upsert({
        ...input,
        projectId: ProjectId.make("project:moved"),
        threadId: launched,
      });
      assert.equal(moved.task.threadId, null);
      assert.equal(moved.task.threadMode, "fresh_session");
      const unbound = yield* service.upsert({ ...input, threadMode: "new_thread" });
      assert.equal(unbound.task.threadId, null);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("caps runs per hour for every trigger but the user's Run now, and keeps the grant", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.updateAndGet(launches, (n) => n + 1).pipe(
                Effect.map((n) => ({ threadId: ThreadId.make(`thread:capped-${n}`) }) as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            getThreadShell: () => Effect.succeed(null),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = {
        id: ScheduledTaskId.make("task:capped"),
        title: "Capped",
        prompt: "Check",
        enabled: true,
        schedule: { type: "interval", everyMs: 3_600_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      const grant = { maxRunsPerHour: 1, budget: { maxCostUsd: 0.5 } };
      assert.deepEqual((yield* service.upsert({ ...input, grant })).task.grant, grant);
      // A client that doesn't know grants saves without one; it stays.
      assert.deepEqual((yield* service.upsert(input)).task.grant, grant);

      yield* service.runNow({ id: input.id }, { byAgent: true });
      const refused = yield* Effect.exit(service.runNow({ id: input.id }, { byAgent: true }));
      assert.isTrue(Exit.isFailure(refused));
      assert.include(String(refused), "This automation allows 1 run per hour.");
      // The user's Run now is never capped.
      yield* service.runNow({ id: input.id });
      assert.equal(yield* Ref.get(launches), 2);
      const { runs } = yield* service.listRuns({ id: input.id });
      assert.deepEqual(
        runs.map((run) => run.trigger.type),
        ["manual", "agent", "agent"],
      );
      assert.equal(runs[1]?.status, "capped");
      assert.equal(runs[1]?.error, "This automation allows 1 run per hour.");

      assert.isUndefined((yield* service.upsert({ ...input, grant: null })).task.grant);
      yield* service.runNow({ id: input.id }, { byAgent: true });
      assert.equal(yield* Ref.get(launches), 3);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a first run whose thread was deleted before it bound removes the task", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread:deleted"),
                resumed: false,
              } as never),
          }),
          // Deleted before the binding landed, so its cleanup found no task to remove.
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            getThreadShell: () =>
              Effect.succeed({ deletedAt: DateTime.makeUnsafe("2026-11-03T00:00:00Z") } as never),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:thread-deleted-mid-launch"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id });
      assert.deepEqual((yield* service.list()).tasks, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["recreated under the same id", "moved to another project"] as const)(
  "a first run never binds its thread to a task %s",
  (change) =>
    Effect.gen(function* () {
      const launching = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ManagedPolicy.layerTest(),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Deferred.succeed(launching, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.as({
                    threadId: ThreadId.make("thread:old-generation"),
                    resumed: false,
                  } as never),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              streamDomainEvents: Stream.empty,
              streamDomainEventsFrom: () => Stream.empty,
              latestDomainEventSequence: Effect.succeed(0),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            NodeCrypto.layer,
            Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = {
          id: ScheduledTaskId.make("task:recreated-mid-launch"),
          title: "Triage",
          prompt: "Triage new issues",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          threadMode: "fresh_session",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        } as const;
        yield* service.upsert(input);
        const run = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(launching);
        if (change === "recreated under the same id") {
          yield* service.delete({ id: input.id });
          yield* TestClock.adjust("1 second");
          yield* service.upsert(input);
        } else {
          yield* service.upsert({ ...input, projectId: ProjectId.make("project:moved") });
        }
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.await(run);

        const replacement = (yield* service.list()).tasks.find((task) => task.id === input.id);
        assert.equal(replacement?.threadId, null);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses saving an enabled task above the policy ceiling", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { maxRuntimeMode: "auto-accept-edits" },
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const save = (enabled: boolean) =>
        service.upsert({
          id: ScheduledTaskId.make("task:above-ceiling"),
          title: "Nightly",
          prompt: "Check progress",
          enabled,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const refused = yield* save(true).pipe(Effect.flip);
      assert.equal(refused.message, "Example Corp limits threads to Auto-accept edits.");
      assert.lengthOf((yield* service.list()).tasks, 0);
      // A disabled task does not run, so it can still be saved.
      yield* save(false);
      assert.lengthOf((yield* service.list()).tasks, 1);
      // Nor can it be switched back on while its mode is above the ceiling.
      const reenabled = yield* service
        .setEnabled({ id: ScheduledTaskId.make("task:above-ceiling"), enabled: true })
        .pipe(Effect.flip);
      assert.equal(reenabled.message, "Example Corp limits threads to Auto-accept edits.");
      // A task bound to a thread runs in that thread's mode, so its own is not checked.
      const bound = {
        id: ScheduledTaskId.make("task:bound"),
        title: "Follow up",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({ ...bound, threadId: ThreadId.make("thread:bound") });
      // Nor when an edit omits the thread it stays bound to.
      yield* service.upsert(bound);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("checks a task's destination thread only when the destination changes", () =>
  Effect.gen(function* () {
    const project = ProjectId.make("project:test");
    const otherProject = ProjectId.make("project:other");
    const destination = ThreadId.make("thread:destination");
    const archivedAt = "2026-11-05T00:00:00.000Z";
    const shells = yield* Ref.make<ReadonlyMap<ThreadId, never>>(
      new Map([
        [destination, threadShell(project)],
        [ThreadId.make("thread:archived"), threadShell(project, { archivedAt })],
        [ThreadId.make("thread:deleted"), threadShell(project, { deletedAt: archivedAt })],
        [ThreadId.make("thread:other-project"), threadShell(otherProject)],
      ]),
    );
    const consumed = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            getThreadShell: (threadId) =>
              Ref.get(shells).pipe(Effect.map((all) => all.get(threadId) ?? null)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({
            consume: () => Ref.update(consumed, (count) => count + 1).pipe(Effect.as("secret")),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const id = ScheduledTaskId.make("task:destination");
      const save = (
        threadId: ThreadId,
        schedule: ScheduledTaskUpsertInput["schedule"] = { type: "interval", everyMs: 60_000 },
      ) =>
        service.upsert({
          id,
          title: "Follow up",
          prompt: "Check progress",
          enabled: true,
          schedule,
          projectId: project,
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });

      for (const [threadId, message] of [
        ["thread:missing", "That thread no longer exists."],
        ["thread:deleted", "That thread no longer exists."],
        ["thread:archived", "That thread is archived. Unarchive it or pick another destination."],
        ["thread:other-project", "That thread belongs to a different project."],
      ] as const) {
        const refused = yield* save(ThreadId.make(threadId)).pipe(Effect.flip);
        assert.equal(refused.message, message);
      }
      assert.lengthOf((yield* service.list()).tasks, 0);

      // A rejected save must not burn a one-shot secret.
      yield* save(ThreadId.make("thread:missing"), {
        type: "webhook",
        signature: {
          header: "x-signature",
          encoding: "hex",
          prefix: "",
          secretRef: SecretRef.make("secret-ref:00000000000000000000000000000001"),
        },
      }).pipe(Effect.flip);
      assert.equal(yield* Ref.get(consumed), 0);

      yield* save(destination);
      // A task whose thread was archived later stays editable.
      yield* Ref.update(shells, (all) =>
        new Map(all).set(destination, threadShell(project, { archivedAt })),
      );
      assert.equal((yield* save(destination)).task.threadId, destination);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run interrupted right after it reserves the task does not block the next run", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:interrupted-reservation"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      // The reservation is the first Set.add of the task id; interrupt the run right there.
      const add = Set.prototype.add;
      let interrupted = false;
      const first = yield* Effect.gen(function* () {
        using _reserve = vi.spyOn(Set.prototype, "add").mockImplementation(function (
          this: Set<unknown>,
          value: unknown,
        ) {
          const result = add.call(this, value);
          if (value === task.id && !interrupted) {
            interrupted = true;
            Fiber.getCurrent()?.interruptUnsafe();
          }
          return result;
        });
        return yield* service
          .runNow({ id: task.id })
          .pipe(Effect.forkChild, Effect.flatMap(Fiber.await));
      });
      assert.isTrue(interrupted);
      assert.isTrue(Exit.hasInterrupts(first));

      const second = yield* service.runNow({ id: task.id });
      assert.equal(second.threadId, ThreadId.make("thread:launched"));
      assert.equal(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("idle check-ins persist their cadence, skip busy ticks, and pause without catch-up", () =>
  Effect.gen(function* () {
    const ticks = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const sends = yield* Ref.make<Array<ThreadManagementService.ThreadManagementSendInput>>([]);
    const busy = yield* Ref.make(false);
    const scheduler: Scheduler.Scheduler["Service"] = {
      register: <E, R>(name: string, run: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          if (name === "scheduled-tasks")
            yield* Ref.set(ticks, run.pipe(Effect.provideContext(context), Effect.orDie));
        }),
    };
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            streamDomainEventsFrom: () => Stream.empty,
            latestDomainEventSequence: Effect.succeed(0),
            getThreadRecords: () => Effect.succeed({ runs: [] } as never),
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
            sendToThread: (input) =>
              Ref.get(busy).pipe(
                Effect.flatMap((blocked) =>
                  blocked
                    ? Effect.fail(
                        new Orchestrator.OrchestratorIdleCheckinSkippedError({
                          threadId: input.threadId,
                          reason: "busy",
                        }),
                      )
                    : Ref.update(sends, (all) => [...all, input]).pipe(Effect.as({} as never)),
                ),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, scheduler),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:idle-checkin"),
        title: "Idle work check-in",
        prompt: "Check ready work",
        enabled: true,
        schedule: { type: "interval", everyMs: 1_800_000, idleCheckin: true, alwaysRun: true },
        projectId: ProjectId.make("project:test"),
        threadId: ThreadId.make("thread:main"),
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const tick = yield* Ref.get(ticks);
      yield* TestClock.adjust("29 minutes");
      yield* tick;
      assert.equal((yield* Ref.get(sends)).length, 0);
      yield* TestClock.adjust("1 minute");
      yield* tick;
      const [sent] = yield* Ref.get(sends);
      assert.equal(sent?.idleCheckin, true);
      assert.equal(sent?.scheduledTaskId, task.id);
      assert.equal(sent?.createdBy, "system");
      assert.equal(sent?.creationSource, "server");
      assert.match(sent?.text ?? "", /Automated cron/);
      assert.match(sent?.text ?? "", /Settings → Scheduled tasks/);
      assert.equal(sent?.threadId, "thread:main");
      yield* Ref.set(busy, true);
      yield* TestClock.adjust("30 minutes");
      yield* tick;
      assert.equal((yield* Ref.get(sends)).length, 1);
      const skipped = (yield* service.list()).tasks[0];
      assert.equal(skipped?.runCount, 1);
      assert.equal(skipped?.lastRunStatus, "succeeded");
      yield* Ref.set(busy, false);
      yield* tick;
      assert.equal((yield* Ref.get(sends)).length, 1);
      yield* service.setEnabled({ id: task.id, enabled: false });
      yield* TestClock.adjust("2 hours");
      yield* tick;
      assert.equal((yield* Ref.get(sends)).length, 1);
      yield* service.setEnabled({ id: task.id, enabled: true });
      yield* tick;
      assert.equal((yield* Ref.get(sends)).length, 1);
      yield* TestClock.adjust("30 minutes");
      yield* tick;
      assert.equal((yield* Ref.get(sends)).length, 2);
    }).pipe(Effect.provide(layer));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      assert.equal((yield* service.list()).tasks[0]?.runCount, 2);
      yield* yield* Ref.get(ticks);
      assert.equal((yield* Ref.get(sends)).length, 2);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
