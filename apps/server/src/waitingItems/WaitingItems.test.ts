import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  waitingMirror,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type WaitingItemSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as EvidenceService from "../evidence/EvidenceService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWorkspace from "../threadWorkspace/ThreadWorkspace.ts";
import * as TicketTracker from "../ticketTracker/TicketTracker.ts";
import * as WaitingItems from "./WaitingItems.ts";

const at = DateTime.makeUnsafe("2026-11-20T12:00:00.000Z");
const question = (
  ref: string,
  state: WaitingItemSummary["state"] = "open",
): WaitingItemSummary => ({
  kind: "question",
  ref,
  key: ref,
  title: "A question from before",
  state,
});

const threadOf = (threadId: ThreadId): OrchestrationV2AppThread =>
  emptyProjection({
    id: EventId.make(`created:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("project"),
      title: "Thread",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    },
  }).thread;

/**
 * Real thread workspaces on disk, QA from a table the test fills, and an orchestrator that applies
 * a waiting sync the way the real one does.
 */
const harness = Effect.fn("test.waitingItemsHarness")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "waiting-items-test-" });
  const config = Context.get(
    yield* Layer.build(ServerConfig.layerTest(root, root)),
    ServerConfig.ServerConfig,
  );
  const threads = new Map(threadIds.map((id) => [id, threadOf(id)]));
  const qa = new Map<ThreadId, ReadonlyArray<WaitingItemSummary>>();
  const qaChanges = yield* Queue.unbounded<ThreadId>();
  const syncs: ThreadId[] = [];
  const synced = yield* Queue.unbounded<ThreadId>();
  const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadRecords: (id) =>
      Effect.sync(
        () =>
          ({
            thread: threads.get(id) ?? threadOf(id),
            messages: [],
            runs: [],
            attempts: [],
            providerTurns: [],
          }) as never,
      ),
    getShellSnapshot: () =>
      Effect.sync(() => ({
        schemaVersion: 1,
        snapshotSequence: 1,
        threads: [...threads.values()] as never,
        archivedThreads: [],
      })),
    streamDomainEvents: Stream.empty,
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.sync(() => {
        if (command.type === "thread.waiting.sync") {
          const thread = threads.get(command.threadId);
          if (thread !== undefined) {
            const { waiting, waitingCounts } = waitingMirror(command.items);
            threads.set(command.threadId, { ...thread, waiting: [...waiting], waitingCounts });
          }
          syncs.push(command.threadId);
          Queue.offerUnsafe(synced, command.threadId);
        }
        return { sequence: 1, storedEvents: [] };
      }),
  });
  const evidence = Layer.mock(EvidenceService.EvidenceService)({
    waitingQa: (threadId) => Effect.sync(() => qa.get(threadId) ?? []),
    waitingQaThreads: () => Effect.sync(() => [...qa.keys()]),
    qaThreadChanges: Stream.fromQueue(qaChanges),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, config),
    orchestrator,
    evidence,
    Layer.mock(TicketTracker.TicketTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    NodeCrypto.layer,
  );
  const workspaceContext = yield* Layer.build(
    ThreadWorkspace.layer.pipe(Layer.provide(dependencies)),
  );
  const context = yield* Layer.build(
    WaitingItems.layer.pipe(
      Layer.provide(Layer.succeedContext(workspaceContext)),
      Layer.provide(dependencies),
    ),
  );
  return {
    service: Context.get(context, WaitingItems.WaitingItems),
    workspace: Context.get(workspaceContext, ThreadWorkspace.ThreadWorkspace),
    threads,
    qa,
    qaChanges,
    syncs,
    synced,
  };
});

it.effect(
  "rebuilds every thread at startup from its stores, dropping a stale mirror's leftovers",
  () =>
    Effect.gen(function* () {
      const asked = ThreadId.make("thread-asked");
      const shrunk = ThreadId.make("thread-shrunk");
      const gone = ThreadId.make("thread-file-gone");
      const tasked = ThreadId.make("thread-tasked");
      const h = yield* harness([asked, shrunk, gone, tasked]);
      // The workspace files hold three open questions in all.
      yield* h.workspace.questionAsk({
        threadId: asked,
        questions: [{ prompt: "Cache size?" }, { prompt: "Region?" }, { prompt: "Retry cap?" }],
      });
      yield* h.workspace.questionUpdate({ threadId: asked, id: "Q2", state: "deferred" }, "user");
      yield* h.workspace.questionUpdate(
        {
          threadId: asked,
          id: "Q3",
          state: "answered",
          answer: { chosenOptionIds: [], notes: "5" },
        },
        "agent",
      );
      yield* h.workspace.questionAsk({
        threadId: shrunk,
        questions: [{ prompt: "Flag name?" }, { prompt: "Ship it?" }],
      });
      yield* h.workspace.questionUpdate(
        {
          threadId: shrunk,
          id: "Q1",
          state: "answered",
          answer: { chosenOptionIds: [], notes: "x" },
        },
        "agent",
      );
      yield* h.workspace.update({
        threadId: tasked,
        expectedRevision: 0,
        changes: [{ text: "Rotate the staging webhook secret", owner: "you" }],
      });
      h.qa.set(asked, [
        { kind: "qa", ref: "QA1", key: "landing-1/toast", title: "Toast count", state: "open" },
      ]);
      // The stale mirror claims twelve open questions, as an incremental mirror outliving its
      // files would.
      const stale = (count: number) =>
        Array.from({ length: count }, (_, index) => question(`Q${index + 1}`));
      for (const [threadId, count] of [
        [asked, 2],
        [shrunk, 6],
        [gone, 4],
      ] as const) {
        const { waiting, waitingCounts } = waitingMirror(stale(count));
        h.threads.set(threadId, {
          ...h.threads.get(threadId)!,
          waiting: [...waiting],
          waitingCounts,
        });
      }
      const openQuestions = () =>
        [...h.threads.values()].reduce(
          (sum, thread) => sum + (thread.waitingCounts?.question ?? 0),
          0,
        );
      expect(openQuestions()).toBe(12);

      expect(yield* h.service.reconcile).toBe(4);

      expect(openQuestions()).toBe(2);
      expect(h.threads.get(asked)?.waitingCounts).toEqual({
        question: 1,
        qa: 1,
        task: 0,
        discussing: 0,
        liveQuestions: 2,
        live: 3,
      });
      expect(h.threads.get(asked)?.waiting?.map((item) => [item.ref, item.state])).toEqual([
        ["Q1", "open"],
        ["Q2", "deferred"],
        ["QA1", "open"],
      ]);
      expect(h.threads.get(shrunk)?.waitingCounts).toMatchObject({ question: 1, qa: 0, task: 0 });
      expect(h.threads.get(gone)?.waiting).toEqual([]);
      expect(h.threads.get(gone)?.waitingCounts).toMatchObject({ question: 0, qa: 0, task: 0 });
      expect(h.threads.get(tasked)?.waitingCounts).toMatchObject({ question: 0, qa: 0, task: 1 });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rebuilds a thread whenever its questions, tasks or QA change", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-live");
    const h = yield* harness([threadId]);
    yield* Effect.forkScoped(h.service.follow);
    const counts = () => h.threads.get(threadId)?.waitingCounts;
    const settle = Effect.gen(function* () {
      yield* Queue.take(h.synced);
      yield* Queue.clear(h.synced);
    });

    yield* h.workspace.questionAsk({ threadId, questions: [{ prompt: "Cache size?" }] });
    yield* settle;
    expect(counts()).toMatchObject({ question: 1, qa: 0, task: 0 });

    yield* h.workspace.update({
      threadId,
      expectedRevision: (yield* h.workspace.get({ threadId })).revision,
      changes: [{ text: "Approve the vendor account", owner: "you" }],
    });
    yield* settle;
    expect(counts()).toMatchObject({ question: 1, qa: 0, task: 1 });

    h.qa.set(threadId, [
      { kind: "qa", ref: "QA1", key: "landing-1/toast", title: "Toast count", state: "open" },
    ]);
    yield* Queue.offer(h.qaChanges, threadId);
    yield* settle;
    expect(counts()).toMatchObject({ question: 1, qa: 1, task: 1 });

    // A QA problem waits on the agent, so it stays listed but leaves the user's count.
    h.qa.set(threadId, [
      { kind: "qa", ref: "QA1", key: "landing-1/toast", title: "Toast count", state: "problem" },
    ]);
    yield* Queue.offer(h.qaChanges, threadId);
    yield* settle;
    expect(counts()).toMatchObject({ question: 1, qa: 0, task: 1 });
    expect(h.threads.get(threadId)?.waiting?.map((item) => item.ref)).toEqual(["Q1", "QA1", "T1"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
