import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  MonitoringError,
  ThreadId,
  MessageId,
  TextGenerationError,
  type MonitoringFinding,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import Migration0097 from "../persistence/Migrations/097_Notifications.ts";
import * as ServerConfig from "../config.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Delivery from "./MonitoringDelivery.ts";
import * as Runner from "./MonitoringRunner.ts";
import * as Snapshot from "./MonitoringSnapshot.ts";
import * as Store from "./MonitoringStore.ts";
import * as Notifications from "../notifications/NotificationService.ts";
import type { ReviewProfile } from "./ReviewProfile.ts";

const profile: ReviewProfile = {
  id: ScheduledTaskId.make("monitoring:watcher"),
  title: "Standards",
  kind: "standards",
  enabled: true,
  turnEnd: false,
  delivery: "thread-or-alert",
  projectId: ProjectId.make("project:test"),
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "haiku" },
  targets: {
    state: "active",
    threadIds: [],
    includeChildren: true,
    minAgeMs: 0,
    updatedWithinMs: null,
  },
  rules: [{ id: "verify", title: "Verify", instructions: "Require observed evidence." }],
};

function taskFor(review: ReviewProfile): ScheduledTask {
  return {
    id: review.id,
    title: review.title,
    prompt: "Read-only review",
    enabled: review.enabled,
    schedule: { type: "interval", everyMs: 60000 },
    projectId: review.projectId,
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: review.modelSelection,
    agent: {
      type: "review",
      kind: review.kind,
      rules: review.rules,
      targets: review.targets,
      delivery: review.delivery,
      ...(review.instructionFiles === undefined
        ? {}
        : { instructionFiles: review.instructionFiles }),
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdBy: "system",
    creationSource: "server",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
}
const run = (review: ReviewProfile) =>
  Effect.flatMap(Runner.MonitoringRunner, (runner) =>
    runner.runTask({ task: taskFor(review), runId: null, threadId: null }),
  );
const notificationsLayer = (raised?: Ref.Ref<ReadonlyArray<Notifications.RaiseInput>>) =>
  Layer.mock(Notifications.NotificationService)({
    raise: (input) =>
      (raised === undefined ? Effect.void : Ref.update(raised, (all) => [...all, input])).pipe(
        Effect.as({
          status: "delivered" as const,
          notification: { id: `notification:${input.title}` } as never,
        }),
      ),
  });
const baseLayers = Layer.mergeAll(
  NodeCrypto.layer,
  NodeServices.layer,
  Layer.effectDiscard(Migration0097).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);

it.effect(
  "records failed runs for an unavailable explicit model without choosing another provider",
  () =>
    Effect.gen(function* () {
      const layer = Runner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Store.MonitoringStore)({}),
            Layer.mock(Snapshot.MonitoringSnapshot)({}),
            Layer.mock(Delivery.MonitoringDelivery)({}),
            Layer.mock(Registry.ProviderInstanceRegistry)({ getInstance: () => Effect.undefined }),
            notificationsLayer(),
            ServerConfig.layerTest("/workspace", { prefix: "t3-monitor-runner-" }),
          ),
        ),
        Layer.provide(baseLayers),
      );
      const result = yield* run(profile).pipe(Effect.provide(layer));
      assert.equal(result.status, "failed");
      assert.include(result.error, "the selected provider cannot run reviews");
      assert.deepEqual(result.notificationIds, []);
    }).pipe(Effect.scoped),
);

it.effect("claims a review before its asynchronous work and releases it when interrupted", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const layer = Runner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Store.MonitoringStore)({}),
          Layer.mock(Snapshot.MonitoringSnapshot)({}),
          Layer.mock(Delivery.MonitoringDelivery)({}),
          Layer.mock(Registry.ProviderInstanceRegistry)({
            getInstance: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(undefined),
              ),
          }),
          notificationsLayer(),
          ServerConfig.layerTest("/workspace", { prefix: "t3-monitor-runner-" }),
        ),
      ),
      Layer.provide(baseLayers),
    );
    yield* Effect.gen(function* () {
      const first = yield* run(profile).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const duplicate = yield* Effect.result(run(profile));
      assert.equal(duplicate._tag, "Failure");
      if (duplicate._tag === "Failure")
        assert.equal(duplicate.failure.operation, "review already running");
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* run(profile)).status, "failed");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("skips unchanged context after a successful review and reviews fresh records", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const newest = yield* Ref.make("1970-01-01T00:00:00.000Z");
    const lastReview = yield* Ref.make<string | null>(null);
    const selected = { ...profile, kind: "context-review" as const };
    const layer = runnerLayer(
      {
        lastReviewAt: () => Ref.get(lastReview),
      },
      {
        capture: () =>
          Ref.get(newest).pipe(
            Effect.map((newestContextAt) => ({
              threads: [
                {
                  id: ThreadId.make("thread"),
                  title: "Main",
                  parentThreadId: null,
                  messages: [{ id: "context:run", role: "context record", text: "Repeated reads" }],
                },
              ],
              truncated: false,
              coverage: "Context records",
              newestContextAt,
            })),
          ),
      },
      () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ findings: [] })),
    );
    yield* Effect.gen(function* () {
      yield* run(selected);
      // The service records each finished run; here the first one.
      yield* Ref.set(lastReview, "1970-01-01T00:00:00.500Z");
      yield* run(selected);
      assert.equal(yield* Ref.get(calls), 1);
      yield* Ref.set(newest, "1970-01-01T00:00:01.000Z");
      yield* run(selected);
      assert.equal(yield* Ref.get(calls), 2);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("deduplicates context proposals by the reviewed run set instead of excerpts", () =>
  Effect.gen(function* () {
    const findings = yield* Ref.make<ReadonlyArray<MonitoringFinding>>([]);
    const excerpt = yield* Ref.make("Repeated");
    const secondRun = yield* Ref.make("context:second");
    const selected = { ...profile, kind: "context-review" as const };
    const layer = runnerLayer(
      {
        getFinding: (id) =>
          Ref.get(findings).pipe(Effect.map((all) => all.find((item) => item.id === id) ?? null)),
        saveFinding: (finding) => Ref.update(findings, (all) => [...all, finding]),
      },
      {
        capture: () =>
          Effect.all([Ref.get(secondRun), Ref.get(excerpt)]).pipe(
            Effect.map(([other, quoted]) => ({
              threads: [
                {
                  id: ThreadId.make("thread"),
                  title: "Main",
                  parentThreadId: null,
                  messages: (quoted === "Repeated"
                    ? ["context:run", other]
                    : [other, "context:run", "context:run"]
                  ).map((id) => ({ id, role: "context record", text: "Repeated reads" })),
                },
              ],
              truncated: false,
              coverage: "Context records",
            })),
          ),
      },
      () =>
        Ref.get(excerpt).pipe(
          Effect.map((excerpt) => ({
            findings: [
              {
                threadId: ThreadId.make("thread"),
                ruleId: "verify",
                summary: "Repeated reads",
                detail: "Use a summary",
                confidence: 0.7,
                evidence: [
                  {
                    threadId: ThreadId.make("thread"),
                    messageId: MessageId.make("context:run"),
                    excerpt,
                  },
                ],
              },
            ],
          })),
        ),
    );
    yield* Effect.gen(function* () {
      yield* run(selected);
      yield* Ref.set(excerpt, "reads");
      yield* run(selected);
      assert.equal((yield* Ref.get(findings)).length, 1);
      yield* Ref.set(secondRun, "context:third");
      yield* run(selected);
      assert.equal((yield* Ref.get(findings)).length, 2);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("records reported model cost when a review fails", () =>
  Effect.gen(function* () {
    const layer = runnerLayer(
      {},
      {
        capture: () =>
          Effect.succeed({
            threads: [
              {
                id: ThreadId.make("thread"),
                title: "Main",
                parentThreadId: null,
                messages: [{ id: "message", role: "assistant", text: "Observed" }],
              },
            ],
            truncated: false,
            coverage: "Chat",
          }),
      },
      (input) =>
        Effect.sync(() => input.onCost?.(0.012)).pipe(
          Effect.andThen(
            Effect.fail(
              new TextGenerationError({
                operation: "generateMonitoringReview",
                detail: "Invalid output",
              }),
            ),
          ),
        ),
    );
    const outcome = yield* run(profile).pipe(Effect.provide(layer));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.costUsd, 0.012);
  }).pipe(Effect.scoped),
);

function runnerLayer(
  store: Partial<Store.MonitoringStore["Service"]>,
  snapshot: Snapshot.MonitoringSnapshot["Service"],
  generate: NonNullable<
    import("@t3tools/provider-core/server/textGeneration").ProviderTextGeneration["generateMonitoringReview"]
  >,
  deliver: Delivery.MonitoringDelivery["Service"]["deliver"] = () =>
    Effect.succeed({ delivery: "workspace", messageId: null }),
  raised?: Ref.Ref<ReadonlyArray<Notifications.RaiseInput>>,
  inbox: Layer.Layer<
    Notifications.NotificationService,
    never,
    SqlClient.SqlClient | SecureRandom.SecureRandom
  > = notificationsLayer(raised),
) {
  return Runner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Store.MonitoringStore)({
          listOpenFindings: () => Effect.succeed([]),
          lastReviewAt: () => Effect.succeed(null),
          getFinding: () => Effect.succeed(null),
          saveFinding: () => Effect.void,
          listThreadFindings: () => Effect.succeed([]),
          reviewWatermark: () => Effect.succeed({}),
          saveReviewWatermark: () => Effect.void,
          ...store,
        }),
        inbox,
        Layer.succeed(Snapshot.MonitoringSnapshot, snapshot),
        Layer.mock(Delivery.MonitoringDelivery)({ deliver }),
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed({
              enabled: true,
              driverKind: "claudeAgent",
              textGeneration: { generateMonitoringReview: generate },
              snapshot: {
                getSnapshot: Effect.succeed({
                  installed: true,
                  enabled: true,
                  status: "ready",
                  auth: { status: "authenticated" },
                  models: [{ slug: "haiku" }],
                }),
              },
            } as never),
        }),
        ServerConfig.layerTest("/workspace", { prefix: "t3-monitor-runner-" }),
      ),
    ),
    Layer.provideMerge(baseLayers),
  );
}

it.effect(
  "retries retained context proposals even when no fresh context needs a model review",
  () =>
    Effect.gen(function* () {
      const proposals = yield* Ref.make<ReadonlyArray<MonitoringFinding>>([]);
      const attempts = yield* Ref.make(0);
      const lastReview = yield* Ref.make<string | null>(null);
      const selected = { ...profile, kind: "context-review" as const };
      const layer = runnerLayer(
        {
          listOpenFindings: () => Ref.get(proposals),
          lastReviewAt: () => Ref.get(lastReview),
          getFinding: (id) =>
            Ref.get(proposals).pipe(
              Effect.map((all) => all.find((item) => item.id === id) ?? null),
            ),
          saveFinding: (finding) => Ref.update(proposals, (all) => [...all, finding]),
        },
        {
          capture: () =>
            Effect.succeed({
              newestContextAt: "1970-01-01T00:00:00.000Z",
              threads: [
                {
                  id: ThreadId.make("thread"),
                  title: "Main",
                  parentThreadId: null,
                  messages: [{ id: "context:run", role: "context record", text: "Repeated reads" }],
                },
              ],
              truncated: false,
              coverage: "Context records",
            }),
        },
        () =>
          Effect.succeed({
            findings: [
              {
                threadId: ThreadId.make("thread"),
                ruleId: "verify",
                summary: "Repeated reads",
                detail: "Use a summary",
                confidence: 0.7,
                evidence: [
                  {
                    threadId: ThreadId.make("thread"),
                    messageId: MessageId.make("context:run"),
                    excerpt: "Repeated",
                  },
                ],
              },
            ],
          }),
        () =>
          Ref.updateAndGet(attempts, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n === 1
                ? Effect.fail(new MonitoringError({ operation: "propose context improvement" }))
                : Effect.succeed({ delivery: "workspace" as const, messageId: null }),
            ),
          ),
      );
      yield* Effect.gen(function* () {
        yield* run(selected);
        assert.equal((yield* Ref.get(proposals)).length, 1);
        yield* Ref.set(lastReview, "1970-01-01T00:00:00.500Z");
        yield* run(selected);
        assert.equal(yield* Ref.get(attempts), 2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "deduplicates context proposals across profiles reviewing the same thread and run set",
  () =>
    Effect.gen(function* () {
      const first: ReviewProfile = { ...profile, kind: "context-review" };
      const second: ReviewProfile = {
        ...first,
        id: ScheduledTaskId.make("monitoring:other-watcher"),
      };
      const findings = yield* Ref.make<ReadonlyArray<MonitoringFinding>>([]);
      const deliveries = yield* Ref.make(0);
      const layer = runnerLayer(
        {
          getFinding: (id) =>
            Ref.get(findings).pipe(Effect.map((all) => all.find((item) => item.id === id) ?? null)),
          saveFinding: (finding) => Ref.update(findings, (all) => [...all, finding]),
        },
        {
          capture: () =>
            Effect.succeed({
              threads: [
                {
                  id: ThreadId.make("thread"),
                  title: "Main",
                  parentThreadId: null,
                  messages: [{ id: "context:run", role: "context record", text: "Repeated reads" }],
                },
              ],
              truncated: false,
              coverage: "Context records",
            }),
        },
        () =>
          Effect.succeed({
            findings: [
              {
                threadId: ThreadId.make("thread"),
                ruleId: "verify",
                summary: "Repeated reads",
                detail: "Use a summary",
                confidence: 0.7,
                evidence: [
                  {
                    threadId: ThreadId.make("thread"),
                    messageId: MessageId.make("context:run"),
                    excerpt: "Repeated",
                  },
                ],
              },
            ],
          }),
        () =>
          Ref.update(deliveries, (n) => n + 1).pipe(
            Effect.as({ delivery: "workspace" as const, messageId: null }),
          ),
      );
      yield* Effect.gen(function* () {
        yield* run(first);
        yield* run(second);
        assert.equal((yield* Ref.get(findings)).length, 1);
        assert.equal(yield* Ref.get(deliveries), 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "injects instruction files and project AGENTS, reports missing files, and caps injected bytes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-instructions-" });
      const instructions = path.join(dir, "standards.md");
      const agents = path.join(dir, "AGENTS.md");
      const large = path.join(dir, "large.md");
      yield* fs.writeFileString(instructions, "Run focused tests before committing.");
      yield* fs.writeFileString(agents, "Comments explain why.");
      yield* fs.writeFileString(large, "大".repeat(40_000));
      let prompt = "";
      const snapshot: Snapshot.MonitoringSnapshotData = {
        projectRoot: dir,
        threads: [
          {
            id: ThreadId.make("thread"),
            title: "Main",
            parentThreadId: null,
            messages: [{ id: "message", role: "assistant", text: "Observed" }],
          },
        ],
        truncated: false,
        coverage: "Chat",
      };
      const selected = {
        ...profile,
        instructionFiles: [instructions, path.join(dir, "missing.md"), large],
        includeProjectAgents: true,
      };
      const layer = runnerLayer({}, { capture: () => Effect.succeed(snapshot) }, (input) => {
        prompt = input.prompt;
        return Effect.succeed({ findings: [] });
      });
      yield* Effect.gen(function* () {
        const runner = yield* Runner.MonitoringRunner;
        yield* runner.review({
          ...selected,
          instructionFiles: selected.instructionFiles.slice(0, 2),
        });
        assert.include(prompt, "Run focused tests before committing.");
        assert.include(prompt, "Comments explain why.");
        assert.include(prompt, "Missing or unreadable instruction file");
        yield* runner.review(selected);
        const payload = JSON.parse(prompt.slice(prompt.indexOf('{"standards":'))) as {
          instructionFiles: string;
        };
        assert.isAtMost(Buffer.byteLength(payload.instructionFiles), 64 * 1024);
        assert.include(payload.instructionFiles, "Instruction sources truncated");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("raises each new finding in the inbox and records the message it was sent as", () =>
  Effect.gen(function* () {
    const findings = yield* Ref.make<ReadonlyArray<MonitoringFinding>>([]);
    const raised = yield* Ref.make<ReadonlyArray<Notifications.RaiseInput>>([]);
    const layer = runnerLayer(
      {
        getFinding: () => Effect.succeed(null),
        saveFinding: (finding) => Ref.update(findings, (all) => [...all, finding]),
      },
      {
        capture: () =>
          Effect.succeed({
            threads: [
              {
                id: ThreadId.make("thread"),
                title: "Main",
                parentThreadId: null,
                messages: [{ id: "msg", role: "assistant", text: "Pushed straight to main" }],
              },
            ],
            truncated: false,
            coverage: "Recent turns",
          }),
      },
      () =>
        Effect.succeed({
          findings: [
            {
              threadId: ThreadId.make("thread"),
              ruleId: "verify",
              summary: "Landed without review",
              detail: "The lead pushed without a review.",
              confidence: 0.9,
              evidence: [
                {
                  threadId: ThreadId.make("thread"),
                  messageId: MessageId.make("msg"),
                  excerpt: "Pushed straight to main",
                },
              ],
            },
          ],
        }),
      () => Effect.succeed({ delivery: "steered", messageId: MessageId.make("monitoring:sent") }),
      raised,
    );
    const outcome = yield* Effect.flatMap(Runner.MonitoringRunner, (runner) =>
      runner.runTask({ task: taskFor(profile), runId: "run:1", threadId: null }),
    ).pipe(Effect.provide(layer));
    const saved = yield* Ref.get(findings);
    assert.equal(saved.at(-1)?.sentToThread?.messageId, "monitoring:sent");
    assert.deepEqual(outcome, {
      status: "notified",
      notificationIds: ["notification:Landed without review"],
      costUsd: undefined,
    });
    const [notification] = yield* Ref.get(raised);
    assert.deepEqual(
      {
        severity: notification?.severity,
        title: notification?.title,
        source: notification?.source,
        threadId: notification?.threadId,
        projectId: notification?.projectId,
      },
      {
        severity: "warning",
        title: "Landed without review",
        source: {
          kind: "review",
          scheduledTaskId: profile.id,
          runId: "run:1",
          findingId: saved[0]!.id,
        },
        threadId: ThreadId.make("thread"),
        projectId: profile.projectId,
      },
    );
    assert.include(notification?.body, "Pushed straight to main");
  }).pipe(Effect.scoped),
);

it.effect("sends every finding of a run to the inbox, past the agents' hourly limit", () =>
  Effect.gen(function* () {
    const count = Notifications.RATE_LIMIT_PER_HOUR + 1;
    const indexes = Array.from({ length: count }, (_, index) => index);
    const layer = runnerLayer(
      {},
      {
        capture: () =>
          Effect.succeed({
            threads: [
              {
                id: ThreadId.make("thread"),
                title: "Main",
                parentThreadId: null,
                messages: indexes.map((index) => ({
                  id: `msg-${index}`,
                  role: "assistant",
                  text: `Pushed straight to main, change ${index}.`,
                })),
              },
            ],
            truncated: false,
            coverage: "Recent turns",
          }),
      },
      () =>
        Effect.succeed({
          findings: indexes.map((index) => ({
            threadId: ThreadId.make("thread"),
            ruleId: "verify",
            summary: `Landed change ${index} without review`,
            detail: "The lead pushed without a review.",
            confidence: 0.9,
            evidence: [
              {
                threadId: ThreadId.make("thread"),
                messageId: MessageId.make(`msg-${index}`),
                excerpt: `change ${index}.`,
              },
            ],
          })),
        }),
      () => Effect.succeed({ delivery: "alert_only", messageId: null }),
      undefined,
      Notifications.layer,
    );
    yield* Effect.gen(function* () {
      const outcome = yield* run(profile);
      assert.equal(outcome.status, "notified");
      assert.equal(outcome.notificationIds.length, count);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ count: number }>`SELECT count(*) AS count FROM notifications`;
      assert.equal(rows[0]?.count, count);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "caps the reviewer's model call at the automation's budget, $0.05 for context reviews",
  () =>
    Effect.gen(function* () {
      const budgets: Array<number | undefined> = [];
      const layer = runnerLayer(
        {},
        {
          capture: () =>
            Effect.succeed({
              threads: [
                {
                  id: ThreadId.make("thread"),
                  title: "Main",
                  parentThreadId: null,
                  messages: [{ id: "message", role: "assistant", text: "Observed" }],
                },
              ],
              truncated: false,
              coverage: "Chat",
            }),
        },
        (input) =>
          Effect.sync(() => {
            budgets.push(input.maxBudgetUsd);
            return { findings: [] };
          }),
      );
      yield* Effect.gen(function* () {
        const runner = yield* Runner.MonitoringRunner;
        const runWith = (review: ReviewProfile, grant?: ScheduledTask["grant"]) =>
          runner.runTask({
            task: { ...taskFor(review), ...(grant === undefined ? {} : { grant }) },
            runId: null,
            threadId: null,
          });
        yield* runWith(profile, { budget: { maxCostUsd: 0.3 } });
        yield* runWith(profile);
        yield* runWith({ ...profile, kind: "context-review" });
        yield* runWith({ ...profile, kind: "context-review" }, { budget: { maxCostUsd: 1 } });
      }).pipe(Effect.provide(layer));
      assert.deepEqual(budgets, [0.3, undefined, 0.05, 1]);
    }).pipe(Effect.scoped),
);

it.effect("reviews a thread's turn end from its watermark and files each incident once", () =>
  Effect.gen(function* () {
    const thread = ThreadId.make("thread");
    const watermark = yield* Ref.make<Readonly<Record<string, string>>>({ thread: "t1" });
    const findings = yield* Ref.make<ReadonlyArray<MonitoringFinding>>([]);
    const raised = yield* Ref.make<ReadonlyArray<Notifications.RaiseInput>>([]);
    const fresh = yield* Ref.make(true);
    const failModel = yield* Ref.make(false);
    const captured: Array<Readonly<Record<string, string>> | undefined> = [];
    const prompts: Array<string> = [];
    const evidence = (messageId: string, excerpt: string) => ({
      threadId: thread,
      messageId: MessageId.make(messageId),
      excerpt,
    });
    const layer = runnerLayer(
      {
        getFinding: (id) =>
          Ref.get(findings).pipe(Effect.map((all) => all.find((item) => item.id === id) ?? null)),
        saveFinding: (finding) => Ref.update(findings, (all) => [...all, finding]),
        listThreadFindings: () => Ref.get(findings),
        reviewWatermark: () => Ref.get(watermark),
        saveReviewWatermark: (_task, _thread, reviewed) => Ref.set(watermark, reviewed),
      },
      {
        capture: (_profile, _threadId, since) =>
          Effect.sync(() => captured.push(since)).pipe(
            Effect.andThen(Ref.get(fresh)),
            Effect.map((hasNew) => ({
              reviewedThrough: hasNew ? { thread: "t3" } : (since ?? {}),
              threads: [
                {
                  id: thread,
                  title: "Main",
                  parentThreadId: null,
                  messages: [
                    { id: "old", role: "assistant", text: "Pushed to main", priorContext: true },
                    ...(hasNew
                      ? [
                          { id: "new", role: "assistant", text: "Pushed to main again" },
                          { id: "claim", role: "assistant", text: "Done, all verified" },
                        ]
                      : []),
                  ],
                },
              ],
              truncated: false,
              coverage: "Chat",
            })),
          ),
      },
      (input) =>
        Effect.sync(() => prompts.push(input.prompt)).pipe(
          Effect.andThen(Ref.get(failModel)),
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new TextGenerationError({ operation: "generateMonitoringReview", detail: "x" }),
                )
              : Effect.succeed({
                  findings: [
                    // Only the context message, which an earlier review already saw.
                    {
                      threadId: thread,
                      ruleId: "verify",
                      summary: "Old push",
                      detail: "d",
                      confidence: 0.9,
                      evidence: [evidence("old", "Pushed to main")],
                    },
                    {
                      threadId: thread,
                      ruleId: "verify",
                      summary: "Pushed again",
                      detail: "d",
                      confidence: 0.9,
                      evidence: [evidence("new", "Pushed to main again")],
                    },
                    // The same incident under another rule.
                    {
                      threadId: thread,
                      ruleId: "review",
                      summary: "Landed unreviewed",
                      detail: "d",
                      confidence: 0.9,
                      evidence: [evidence("new", "again"), evidence("claim", "Done")],
                    },
                  ],
                }),
          ),
        ),
      () => Effect.succeed({ delivery: "alert_only", messageId: null }),
      raised,
    );
    const turnEnd: ReviewProfile = {
      ...profile,
      turnEnd: true,
      rules: [...profile.rules, { id: "review", title: "Review", instructions: "Review." }],
    };
    const runTurnEnd = Effect.flatMap(Runner.MonitoringRunner, (runner) =>
      runner.runTask({ task: taskFor(turnEnd), runId: null, threadId: thread }),
    );
    yield* Effect.gen(function* () {
      yield* Ref.set(failModel, true);
      assert.equal((yield* runTurnEnd).status, "failed");
      assert.deepEqual(yield* Ref.get(watermark), { thread: "t1" });
      yield* Ref.set(failModel, false);
      assert.equal((yield* runTurnEnd).status, "notified");
      assert.deepEqual(captured, [{ thread: "t1" }, { thread: "t1" }]);
      assert.deepEqual(
        (yield* Ref.get(raised)).map((input) => input.title),
        ["Pushed again"],
      );
      assert.deepEqual(yield* Ref.get(watermark), { thread: "t3" });
      // The next turn sees the filed incident in its prompt and does not file it again.
      assert.equal((yield* runTurnEnd).status, "quiet");
      assert.include(
        prompts.at(-1),
        '"priorFindings":[{"ruleId":"verify","summary":"Pushed again"',
      );
      assert.notInclude(prompts.at(-1), "reviewedThrough");
      yield* Ref.set(fresh, false);
      const calls = prompts.length;
      assert.equal((yield* runTurnEnd).status, "quiet");
      assert.equal(prompts.length, calls);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
