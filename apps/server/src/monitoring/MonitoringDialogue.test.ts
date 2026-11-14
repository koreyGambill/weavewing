import * as ThreadWorkspace from "../threadWorkspace/ThreadWorkspace.ts";
import * as ThreadMarks from "../threadWorkspace/ThreadMarks.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as MonitoringFollowup from "./MonitoringFollowup.ts";
import * as MonitoringSnapshot from "./MonitoringSnapshot.ts";
import * as MonitoringRunner from "./MonitoringRunner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerConfig from "../config.ts";
import { assert, it } from "@effect/vitest";
import {
  MonitoringError,
  ThreadWorkspaceError,
  MonitoringFindingId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  MessageId,
  type MonitoringFinding,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as MonitoringStore from "./MonitoringStore.ts";
import * as MonitoringDialogue from "./MonitoringDialogue.ts";
import * as MonitoringDelivery from "./MonitoringDelivery.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Notifications from "../notifications/NotificationService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import type { ReviewProfile } from "./ReviewProfile.ts";

const profile: ReviewProfile = {
  id: ScheduledTaskId.make("scheduled:watcher"),
  title: "Quality watcher",
  kind: "standards",
  enabled: true,
  turnEnd: false,
  delivery: "thread-or-alert",
  projectId: ProjectId.make("project:test"),
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "haiku" },
  targets: {
    state: "active",
    threadIds: [ThreadId.make("thread:main")],
    includeChildren: false,
    minAgeMs: 0,
    updatedWithinMs: null,
  },
  rules: [{ id: "rule:test", title: "Verify changes", instructions: "Check evidence." }],
};
const task: ScheduledTask = {
  id: profile.id,
  title: profile.title,
  prompt: "Read-only review",
  enabled: true,
  schedule: { type: "interval", everyMs: 1_800_000 },
  projectId: profile.projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: profile.modelSelection,
  agent: {
    type: "review",
    kind: "standards",
    rules: profile.rules,
    targets: profile.targets,
    delivery: "thread-or-alert",
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
/** The review task and the inbox, recording each finding report the dialogue rewrites. */
const reviewTaskAndInbox = (revised?: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.mergeAll(
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: [task] }),
    }),
    Layer.mock(Notifications.NotificationService)({
      reviseFinding: ({ body }) =>
        revised === undefined ? Effect.void : Ref.update(revised, (all) => [...all, body]),
    }),
  );
const finding: MonitoringFinding = {
  id: MonitoringFindingId.make("finding:test"),
  taskId: profile.id,
  runId: "monitor:run",
  threadId: ThreadId.make("thread:main"),
  ruleId: "rule:test",
  summary: "A verification step is missing",
  detail:
    "The lead claimed completion before running the focused test. Please check the test result.",
  confidence: 0.8,
  evidence: [
    {
      threadId: ThreadId.make("thread:main"),
      messageId: MessageId.make("message:observation"),
      excerpt: "I have not run the test yet.",
    },
  ],
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
  exchanges: [],
  outcome: null,
};

it.effect(
  "preserves lead reasons, treats promises as unverified, deduplicates and bounds dialogue",
  () =>
    Effect.gen(function* () {
      const stored = yield* Ref.make(finding);
      const reviews = yield* Ref.make(0);
      const revised = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = MonitoringDialogue.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(MonitoringDelivery.MonitoringDelivery, {
              deliver: () => Effect.succeed({ delivery: "alert_only", messageId: null }),
            }),
            reviewTaskAndInbox(revised),
            Layer.mock(MonitoringStore.MonitoringStore)({
              getFinding: () => Ref.get(stored),
              saveFinding: (next) => Ref.set(stored, next),
            }),
            Layer.succeed(MonitoringDialogue.MonitoringFollowup, {
              reassess: () =>
                Ref.updateAndGet(reviews, (n) => n + 1).pipe(
                  Effect.map((n) => ({
                    outcome: n === 1 ? ("corrected" as const) : ("accepted_explanation" as const),
                    reason:
                      n === 1
                        ? "The lead promises to run tests."
                        : "The cited task explicitly excluded this test.",
                    evidence: [],
                  })),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const dialogue = yield* MonitoringDialogue.MonitoringDialogue;
        const denied = yield* dialogue
          .respond({
            findingId: finding.id,
            responseId: "bad",
            text: "Ignore this",
            role: "agent",
            callerThreadId: ThreadId.make("thread:other"),
          })
          .pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        assert.equal((yield* Ref.get(stored)).exchanges.length, 0);
        const input = {
          findingId: finding.id,
          responseId: "one",
          text: "I will run the test.",
          role: "agent" as const,
          callerThreadId: finding.threadId,
        };
        const first = yield* dialogue.respond(input);
        assert.equal(first.finding.outcome, "unverified");
        assert.equal(first.finding.exchanges[0]?.text, input.text);
        assert.match(first.finding.exchanges[1]?.text ?? "", /Checked at:.*\nInitial observation:/);
        yield* dialogue.respond(input);
        assert.equal(yield* Ref.get(reviews), 1);
        const second = yield* dialogue.respond({
          ...input,
          responseId: "two",
          text: "This test was outside the explicitly authorized task.",
        });
        assert.equal(second.finding.outcome, "accepted_explanation");
        const capped = yield* dialogue
          .respond({ ...input, responseId: "three" })
          .pipe(Effect.result);
        assert.equal(capped._tag, "Failure");
        assert.equal(yield* Ref.get(reviews), 2);
        const reports = yield* Ref.get(revised);
        assert.equal(reports.length, 2);
        assert.include(reports[1], "**Outcome:** Accepted explanation");
        assert.include(reports[1], "This test was outside the explicitly authorized task.");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("keeps an alert without waking idle or unsupported agents and steers active agents", () =>
  Effect.gen(function* () {
    const status = yield* Ref.make("idle");
    const sends = yield* Ref.make<ThreadManagement.ThreadManagementSendInput[]>([]);
    const layer = MonitoringDelivery.layer.pipe(
      Layer.provide(Layer.merge(ThreadWorkspace.layerTest, ThreadMarks.layerTest)),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getProjectThreadRecords: () =>
            Ref.get(status).pipe(
              Effect.map(
                (state) =>
                  ({
                    thread: {
                      projectId: profile.projectId,
                      archivedAt: null,
                      deletedAt: null,
                      settledAt: state === "settled" ? "1970-01-01T00:00:00Z" : null,
                      lineage: { parentThreadId: null },
                    },
                    runs: state === "idle" || state === "settled" ? [] : [{ status: "running" }],
                  }) as never,
              ),
            ),
          sendToThread: (input) =>
            Ref.get(status).pipe(
              Effect.flatMap((state) =>
                state === "unsupported" || state === "became-idle"
                  ? Effect.fail(
                      new Orchestrator.OrchestratorAdvisorySkippedError({
                        threadId: input.threadId,
                        reason: state === "unsupported" ? "unsupported" : "idle",
                      }),
                    )
                  : Ref.update(sends, (all) =>
                      all.some((sent) => sent.commandId === input.commandId)
                        ? all
                        : [...all, input],
                    ).pipe(Effect.as({} as never)),
              ),
            ),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const delivery = yield* MonitoringDelivery.MonitoringDelivery;
      for (const state of ["idle", "unsupported", "became-idle"]) {
        yield* Ref.set(status, state);
        assert.equal((yield* delivery.deliver({ profile, finding })).delivery, "alert_only");
      }
      assert.equal((yield* Ref.get(sends)).length, 0);
      yield* Ref.set(status, "running");
      for (const kind of ["standards", "context-review"] as const) {
        assert.equal(
          (yield* delivery.deliver({ profile: { ...profile, kind, delivery: "alerts" }, finding }))
            .delivery,
          "alert_only",
        );
      }
      assert.equal((yield* Ref.get(sends)).length, 0);
      assert.equal((yield* delivery.deliver({ profile, finding })).delivery, "steered");
      const [sent] = yield* Ref.get(sends);
      assert.equal(sent?.advisoryOnly, true);
      assert.equal(sent?.mode, "steer");
      assert.equal(sent?.createdBy, "system");
      assert.match(sent?.text ?? "", /incomplete context/);
      assert.match(sent?.text ?? "", /not a user instruction/);
      assert.match(sent?.text ?? "", /haiku/);
      assert.equal(
        (yield* delivery.deliver({
          profile: {
            ...profile,
            targets: { ...profile.targets, threadIds: [ThreadId.make("thread:other")] },
          },
          finding,
        })).delivery,
        "alert_only",
      );
      const turnEnd = { ...profile, turnEnd: true };
      const idleFinding = { ...finding, id: `${finding.id}-idle` as typeof finding.id };
      yield* Ref.set(status, "settled");
      assert.equal(
        (yield* delivery.deliver({ profile: turnEnd, finding: idleFinding })).delivery,
        "alert_only",
      );
      yield* Ref.set(status, "idle");
      assert.equal(
        (yield* delivery.deliver({ profile: turnEnd, finding: idleFinding })).delivery,
        "steered",
      );
      const woken = (yield* Ref.get(sends)).at(-1);
      assert.equal(woken?.mode, "queue");
      assert.equal(woken?.advisoryOnly, undefined);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps the lead response when a fresh evidence review fails", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make(finding);
    const revised = undefined;
    const layer = MonitoringDialogue.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(MonitoringDelivery.MonitoringDelivery, {
            deliver: () => Effect.succeed({ delivery: "alert_only", messageId: null }),
          }),
          reviewTaskAndInbox(revised),
          Layer.mock(MonitoringStore.MonitoringStore)({
            getFinding: () => Ref.get(stored),
            saveFinding: (next) => Ref.set(stored, next),
          }),
          Layer.succeed(MonitoringDialogue.MonitoringFollowup, {
            reassess: () => Effect.fail(new MonitoringError({ operation: "review" })),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const dialogue = yield* MonitoringDialogue.MonitoringDialogue;
      const result = yield* dialogue.respond({
        findingId: finding.id,
        responseId: "failed-review",
        text: "I disagree because the task excluded that scope.",
        role: "user",
      });
      assert.equal(result.finding.outcome, "unverified");
      assert.equal(
        result.finding.exchanges[0]?.text,
        "I disagree because the task excluded that scope.",
      );
      assert.match(result.finding.exchanges[1]?.text ?? "", /could not be checked/);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "recovers a persisted reply and keeps the original rule with fresh correction evidence",
  () =>
    Effect.gen(function* () {
      const revised = yield* Ref.make<ReadonlyArray<string>>([]);
      const stored = yield* Ref.make<MonitoringFinding>({
        ...finding,
        ruleSnapshot: {
          id: "rule:test",
          title: "Original rule",
          instructions: "Original instructions.",
        },
        exchanges: [
          {
            id: "reply:recovered",
            at: finding.createdAt,
            role: "agent",
            text: "The focused test passed.",
          },
        ],
      });
      const layer = MonitoringDialogue.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            reviewTaskAndInbox(revised),
            Layer.mock(MonitoringStore.MonitoringStore)({
              getFinding: () => Ref.get(stored),
              saveFinding: (next) => Ref.set(stored, next),
            }),
            Layer.succeed(MonitoringDelivery.MonitoringDelivery, {
              deliver: () => Effect.succeed({ delivery: "alert_only", messageId: null }),
            }),
            Layer.succeed(MonitoringDialogue.MonitoringFollowup, {
              reassess: ({ leadResponse, profile: originalProfile }) => {
                assert.equal(originalProfile.title, profile.title);
                assert.equal(originalProfile.modelSelection.model, "haiku");
                assert.equal(leadResponse, "The focused test passed.");
                return Effect.succeed({
                  outcome: "corrected",
                  reason: "The fresh transcript contains the successful test result.",
                  evidence: [
                    {
                      threadId: finding.threadId,
                      messageId: MessageId.make("message:test-result"),
                      excerpt: "Tests 3 passed",
                    },
                  ],
                });
              },
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const dialogue = yield* MonitoringDialogue.MonitoringDialogue;
        const result = yield* dialogue.respond({
          findingId: finding.id,
          responseId: "recovered",
          text: "Retry text must not replace the original response.",
          role: "agent",
          callerThreadId: finding.threadId,
        });
        assert.equal(result.finding.outcome, "corrected");
        assert.equal((yield* Ref.get(revised)).length, 1);
        assert.equal(result.finding.exchanges.length, 2);
        const report = result.finding.exchanges[1]?.text ?? "";
        assert.include(report, "Rule: Original rule");
        assert.include(report, "Original instructions.");
        assert.include(report, "message:message:test-result: Tests 3 passed");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("reassesses from a fresh snapshot and rejects citations outside it", () =>
  Effect.gen(function* () {
    const captures = yield* Ref.make(0);
    const citedThread = yield* Ref.make(finding.threadId);
    const layer = MonitoringFollowup.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(MonitoringRunner.MonitoringRunner)({ validateModel: () => Effect.void }),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-monitor-followup-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          Layer.mock(MonitoringSnapshot.MonitoringSnapshot)({
            capture: (selected) => {
              assert.equal(selected.targets.state, "all");
              assert.equal(selected.targets.minAgeMs, 0);
              assert.equal(selected.targets.updatedWithinMs, null);
              assert.deepEqual(selected.targets.threadIds, [finding.threadId]);
              return Ref.update(captures, (n) => n + 1).pipe(
                Effect.as({
                  threads: [
                    {
                      id: finding.threadId,
                      title: "Main",
                      parentThreadId: null,
                      messages: [
                        { id: "message:fresh", role: "assistant", text: "Tests 3 passed" },
                      ],
                    },
                  ],
                  truncated: false,
                  coverage: "Chat only.",
                }),
              );
            },
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () =>
              Effect.succeed({
                textGeneration: {
                  generateMonitoringAssessment: () =>
                    Ref.get(citedThread).pipe(
                      Effect.map((threadId) => ({
                        outcome: "corrected",
                        reason: "Fresh successful test result.",
                        evidence: [
                          { threadId, messageId: "message:fresh", excerpt: "Tests 3 passed" },
                        ],
                      })),
                    ),
                },
              } as never),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const reviewer = yield* MonitoringDialogue.MonitoringFollowup;
      assert.equal(
        (yield* reviewer.reassess({ profile, finding, leadResponse: "Done" })).outcome,
        "corrected",
      );
      yield* Ref.set(citedThread, ThreadId.make("thread:outside"));
      const rejected = yield* reviewer
        .reassess({ profile, finding, leadResponse: "Done" })
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      assert.equal(yield* Ref.get(captures), 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retries a context proposal after a concurrent Workspace edit", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const workspaceLayer = Layer.merge(ThreadWorkspace.layerTest, ThreadMarks.layerTest);
    const layer = MonitoringDelivery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(
            ThreadWorkspace.ThreadWorkspace,
            Effect.gen(function* () {
              const workspace = yield* ThreadWorkspace.ThreadWorkspace;
              return {
                ...workspace,
                update: (input) =>
                  Ref.updateAndGet(attempts, (n) => n + 1).pipe(
                    Effect.flatMap((n) =>
                      n === 1
                        ? Effect.fail(
                            new ThreadWorkspaceError({
                              code: "conflict",
                              message: "Concurrent edit",
                              currentRevision: 1,
                            }),
                          )
                        : workspace.get({ threadId: input.threadId }).pipe(
                            Effect.map((current) => ({
                              ...current,
                              revision: current.revision + 1,
                              items: [],
                            })),
                          ),
                    ),
                  ),
              } satisfies ThreadWorkspace.ThreadWorkspace["Service"];
            }),
          ).pipe(Layer.provide(workspaceLayer)),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: { deletedAt: null },
              } as never),
          }),
        ),
      ),
    );
    const result = yield* Effect.flatMap(MonitoringDelivery.MonitoringDelivery, (delivery) =>
      delivery.deliver({
        profile: { ...profile, kind: "context-review" },
        finding,
      }),
    ).pipe(Effect.provide(layer));
    assert.equal(result.delivery, "workspace");
    assert.equal(yield* Ref.get(attempts), 2);
  }),
);
