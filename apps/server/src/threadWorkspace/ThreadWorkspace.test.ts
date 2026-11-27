// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  RunAttemptId,
  RunId,
  MessageId,
  ComposerContextId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type WaitingItemSummary,
  waitingMirror,
  type ThreadWorkspaceError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as TicketTracker from "../ticketTracker/TicketTracker.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Workspaces from "./ThreadWorkspace.ts";
import fixture from "./testdata/legacy-workspace.json" with { type: "json" };

const threadId = ThreadId.make("thread-test");
const at = DateTime.makeUnsafe("2026-11-05T12:00:00.000Z");
function trackedMessage(id: string): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    createdBy: "user",
    creationSource: "web",
    origin: { kind: "user" },
    text: "What resets the counter?",
    attachments: [],
    context: { version: 1, records: [], trackedAsk: { question: "What resets the counter?" } },
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
}
const harness = Effect.fn("test.workspaceHarness")(function* () {
  // The user message of the thread's current turn, as the orchestrator reads it. `sole` says
  // whether it is the one user message since the anchor a caller passes, which `anchors` records.
  const turnMessage = {
    current: null as MessageId | null,
    sole: true,
    anchors: [] as Array<string>,
  };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-workspace-test-" });
  const configContext = yield* Layer.build(ServerConfig.layerTest(root, root));
  const config = Context.get(configContext, ServerConfig.ServerConfig);
  const projection = emptyProjection({
    id: EventId.make("created"),
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
  });
  let closed = false;
  let staleClosed = false;
  let laneStatus: OrchestrationV2Run["status"] = "running";
  const sends: ThreadManagement.ThreadManagementSendInput[] = [];
  const mirror = { waiting: [] as ReadonlyArray<WaitingItemSummary> };
  const threadState = { archivedAt: null as DateTime.Utc | null };
  const delegatedChildren = new Set<ThreadId>();
  // Like the orchestrator's command receipts: a repeated command id delivers nothing new.
  const delivered: ThreadManagement.ThreadManagementSendInput[] = [];
  const hooks = {
    onSend: (): void => undefined,
    beforeRead: (_id: ThreadId): Effect.Effect<void> => Effect.void,
  };
  const messages: OrchestrationV2ConversationMessage[] = [];
  // The thread's own runs; another thread id reads as a delegated lane with one run.
  const threadRuns: OrchestrationV2Run[] = [];
  // A provider turn for one of a run's attempts is how a provider's acceptance is recorded.
  const threadAttempts: OrchestrationV2RunAttempt[] = [];
  const threadProviderTurns: OrchestrationV2ProviderTurn[] = [];
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const run = (): OrchestrationV2Run => ({
    id: RunId.make("run"),
    threadId,
    ordinal: 1,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: laneStatus,
    requestedAt: at,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, config),
    Layer.succeed(TicketTracker.TicketTracker, {
      get: (key, fresh) =>
        Effect.sync(() => {
          if (fresh) staleClosed = false;
          return {
            key,
            title: "Sample ticket",
            stage: closed || staleClosed ? "closed" : "active",
            terminal: closed || staleClosed,
            url: "https://example.com/ticket",
          };
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getCurrentUserMessageId: (_thread, options) =>
        Effect.sync(() => {
          if (options?.soleSince === undefined) return turnMessage.current;
          turnMessage.anchors.push(options.soleSince);
          return turnMessage.sole ? turnMessage.current : null;
        }),
      getThreadRecords: (id) =>
        hooks.beforeRead(id).pipe(
          Effect.map(() => ({
            ...projection,
            messages,
            thread: {
              ...projection.thread,
              id,
              waiting: mirror.waiting,
              archivedAt: threadState.archivedAt,
              ...(delegatedChildren.has(id)
                ? {
                    lineage: {
                      parentThreadId: threadId,
                      rootThreadId: threadId,
                      relationshipToParent: "subagent" as const,
                    },
                  }
                : {}),
            },
            runs: id === threadId ? threadRuns : [run()],
            attempts: id === threadId ? threadAttempts : [],
            providerTurns: id === threadId ? threadProviderTurns : [],
          })),
        ),
      streamDomainEvents: Stream.fromQueue(domainEvents),
      dispatch: (_command: OrchestrationV2ServerCommand) =>
        Effect.succeed({ sequence: 1, storedEvents: [] }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.sync(() => {
          sends.push(input);
          if (!delivered.some((sent) => sent.commandId === input.commandId)) delivered.push(input);
          hooks.onSend();
          return {
            dispatch: { sequence: 1, storedEvents: [] },
            projection,
            run: run(),
            turnItem: null,
            delivery: "queued" as const,
            message: {
              id: input.messageId,
              threadId,
              runId: null,
              nodeId: null,
              role: "user" as const,
              createdBy: "user" as const,
              creationSource: "web" as const,
              text: input.text,
              attachments: [],
              streaming: false,
              createdAt: at,
              updatedAt: at,
            },
          };
        }),
    }),
  );
  const context = yield* Layer.build(Workspaces.layer.pipe(Layer.provide(dependencies)));
  const service = Context.get(context, Workspaces.ThreadWorkspace);
  const changed = yield* Queue.unbounded<ThreadId>();
  yield* Stream.runForEach(service.changes, (id) => Queue.offer(changed, id)).pipe(
    Effect.forkScoped,
  );
  /** The thread's questions as the waiting-items mirror shows them, kept for the follower's check. */
  const mirrored = () =>
    service.waitingItems(threadId).pipe(
      Effect.map(({ items }) => {
        mirror.waiting = items;
        return items.filter((item) => item.kind === "question");
      }),
    );
  return {
    // The list writes return the saved list here; `writes` keeps what each write reported.
    service: {
      ...service,
      update: (...args: Parameters<typeof service.update>) =>
        service.update(...args).pipe(Effect.map((write) => write.workspace)),
      rewrite: (...args: Parameters<typeof service.rewrite>) =>
        service.rewrite(...args).pipe(Effect.map((write) => write.workspace)),
    },
    writes: service,
    turnMessage,
    sends,
    delivered,
    hooks,
    threadState,
    delegatedChildren,
    mirror,
    mirrored,
    changed,
    messages,
    threadRuns,
    /** Records the provider accepting `runId`'s turn: an attempt and its provider turn. */
    acceptTurn: (runId: string) => {
      const attemptId = RunAttemptId.make(`${runId}-attempt`);
      threadAttempts.push({ id: attemptId, runId: RunId.make(runId) } as OrchestrationV2RunAttempt);
      threadProviderTurns.push({ runAttemptId: attemptId } as OrchestrationV2ProviderTurn);
    },
    domainEvents,
    fs,
    path,
    config,
    dependencies,
    closeTicket: () => {
      closed = true;
    },
    reopenTicket: () => {
      closed = false;
      staleClosed = true;
    },
    finishLane: () => {
      laneStatus = "completed";
    },
  };
});

it.effect("only permits answering a delivered, unsettled tracked question", () =>
  Effect.gen(function* () {
    const { service } = yield* harness();
    const message = trackedMessage("first");
    yield* service.recordTrackedMessages(threadId, [message], false);
    const send = (id: string, text = "The reconnect handler.") =>
      service.answerAsk({ threadId, id, text, runId: null });
    const refusal = (effect: ReturnType<typeof send>, message: string) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(effect);
        expect(error.message).toBe(message);
      });
    yield* refusal(send("A9"), "A9 does not exist in this thread.");
    yield* refusal(send("A1"), "A1 has not reached you yet.");
    yield* service.recordTrackedMessages(threadId, [message], true);
    yield* refusal(send("A1", "  "), "Give a nonempty answer.");
    yield* refusal(
      send("A1", "a".repeat(4001)),
      "Keep the answer under 4000 characters, and pass the rest as more.",
    );
    expect((yield* send("A1")).n).toBe(1);
    expect((yield* send("A1", "Both handlers.")).n).toBe(2);
    const close = (action: "close" | "reopen" | "withdraw" | "restore") =>
      service.updateAsk({ threadId, id: "A1", action });
    expect((yield* close("close")).state).toBe("closed");
    yield* refusal(
      send("A1"),
      "The user closed A1. They reopen it if they want more, so do not answer it again.",
    );
    expect((yield* close("reopen")).state).toBe("answered");
    expect((yield* close("withdraw")).state).toBe("withdrawn");
    yield* refusal(send("A1"), "The user withdrew A1.");
    expect((yield* close("restore")).state).toBe("owed");
    expect((yield* send("A1")).n).toBe(3);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps tracking idempotent and preserves a user edit and a sent follow-up", () =>
  Effect.gen(function* () {
    const { service } = yield* harness();
    const message = trackedMessage("first");
    const second = trackedMessage("second");
    yield* service.recordTrackedMessages(threadId, [message, second], false);
    yield* service.updateAsk({ threadId, id: "A1", action: "edit", question: "Which handler?" });
    yield* service.recordTrackedMessages(threadId, [message], true);
    yield* service.answerAsk({ threadId, id: "A1", text: "Reconnect.", runId: null });
    const followUp = {
      ...trackedMessage("follow-up"),
      context: { version: 1 as const, records: [], discussAnswers: ["A1"] },
    };
    yield* service.recordTrackedMessages(threadId, [followUp], true);
    expect((yield* service.get({ threadId })).asks).toMatchObject([
      {
        id: "A1",
        question: "Which handler?",
        state: "owed",
        followUps: [{ messageId: followUp.id }],
      },
      { id: "A2", state: "queued" },
    ]);
    yield* service.answerAsk({ threadId, id: "A1", text: "Both reconnect handlers.", runId: null });
    yield* service.recordTrackedMessages(threadId, [followUp], true);
    expect((yield* service.get({ threadId })).asks?.[0]).toMatchObject({
      state: "answered",
      followUps: [{ messageId: followUp.id }],
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps an answered ask settled until its queued discussion is delivered", () =>
  Effect.gen(function* () {
    const { service } = yield* harness();
    yield* service.recordTrackedMessages(threadId, [trackedMessage("first")], true);
    yield* service.answerAsk({ threadId, id: "A1", text: "Reconnect.", runId: null });
    const followUp = {
      ...trackedMessage("follow-up"),
      context: { version: 1 as const, records: [], discussAnswers: ["A1"] },
    };
    yield* service.recordTrackedMessages(threadId, [followUp], false);
    const edited = { ...followUp, context: { ...followUp.context, discussAnswers: [] } };
    yield* service.recordTrackedMessages(threadId, [edited], false, true);
    yield* service.recordTrackedMessages(threadId, [edited], true);
    expect((yield* service.get({ threadId })).asks?.[0]).toMatchObject({
      state: "answered",
      followUps: [],
    });
    const nextFollowUp = { ...followUp, id: MessageId.make("next-follow-up") };
    yield* service.recordTrackedMessages(threadId, [nextFollowUp], true);
    expect((yield* service.get({ threadId })).asks?.[0]).toMatchObject({
      state: "owed",
      followUps: [{ messageId: nextFollowUp.id }],
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses duplicate and foreign marks and directs a child to give its result to its lead",
  () =>
    Effect.gen(function* () {
      const { service, messages, delegatedChildren } = yield* harness();
      const message = trackedMessage("sent");
      const guest = { ...trackedMessage("guest"), createdBy: "agent" as const };
      messages.push(message, guest);
      const track = (messageId: MessageId) => service.trackMessage({ threadId, messageId });
      expect((yield* track(message.id)).state).toBe("owed");
      expect((yield* Effect.flip(track(message.id))).message).toBe(
        "That message already has a tracked answer.",
      );
      expect((yield* Effect.flip(track(guest.id))).message).toBe(
        "You can only track an answer to your own message.",
      );
      expect((yield* Effect.flip(track(MessageId.make("missing")))).message).toBe(
        "Message not found.",
      );
      const child = ThreadId.make("child");
      delegatedChildren.add(child);
      const attempted = yield* Effect.flip(
        service.answerAsk({
          id: "A1",
          threadId: child,
          text: "The reconnect handler.",
          runId: null,
        }),
      );
      expect(attempted.message).toBe(
        "A1 belongs to your lead's thread. Put the answer in your result; the lead gives it.",
      );
      expect((yield* service.get({ threadId })).asks?.[0]?.state).toBe("owed");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a queued edit's ref and allocates a new ref after tracking is turned off", () =>
  Effect.gen(function* () {
    const { service } = yield* harness();
    const original = trackedMessage("queued");
    yield* service.recordTrackedMessages(threadId, [original], false);
    const edited = {
      ...original,
      context: {
        version: 1 as const,
        records: [],
        trackedAsk: { question: "When does the counter reset?" },
      },
    };
    const kept = yield* service.recordTrackedMessages(threadId, [edited], false, true);
    expect(kept).toMatchObject([
      { id: "A1", question: "When does the counter reset?", state: "queued" },
    ]);
    const legacyEdit = { ...edited, context: { version: 1 as const, records: [] } };
    expect(yield* service.recordTrackedMessages(threadId, [legacyEdit], false, true)).toMatchObject(
      [{ id: "A1", state: "queued" }],
    );
    const untracked = {
      ...legacyEdit,
      context: { ...legacyEdit.context, clearTrackedAsk: true as const },
    };
    yield* service.recordTrackedMessages(threadId, [untracked], false, true);
    expect((yield* service.get({ threadId })).asks).toEqual([]);
    const trackedAgain = yield* service.recordTrackedMessages(threadId, [edited], false, true);
    expect(trackedAgain).toMatchObject([{ id: "A2", state: "queued" }]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("pages archived tracked answers with counts from the whole environment", () =>
  Effect.gen(function* () {
    const { service, threadState } = yield* harness();
    yield* service.recordTrackedMessages(
      threadId,
      Array.from({ length: 52 }, (_, index) => trackedMessage(`message-${index}`)),
      true,
    );
    threadState.archivedAt = at;
    const first = yield* service.asksRead({ all: true });
    expect(first.entries).toHaveLength(50);
    expect(first.counts).toEqual({ owed: 52, toRead: 0, closed: 0 });
    expect(first.entries.every((row) => row.archived)).toBe(true);
    const next = yield* service.asksRead({ all: true, cursor: first.cursor! });
    expect(next.entries).toHaveLength(2);
    expect(next.cursor).toBeUndefined();
    expect(new Set([...first.entries, ...next.entries].map((row) => row.ask.id)).size).toBe(52);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "lets a tracked answer write complete during an All scan and stops the scan on interrupt",
  () =>
    Effect.gen(function* () {
      const { service, hooks } = yield* harness();
      const historyThreads = Array.from({ length: 12 }, (_, index) =>
        ThreadId.make(`history-${index}`),
      );
      for (const id of [...historyThreads, threadId]) {
        yield* service.recordTrackedMessages(
          id,
          [{ ...trackedMessage("question"), threadId: id }],
          true,
        );
      }
      const scanPaused = yield* Deferred.make<void>();
      const continuation = yield* Deferred.make<void>();
      const readThreads: ThreadId[] = [];
      hooks.beforeRead = (id) => {
        if (id === threadId) return Effect.void;
        readThreads.push(id);
        return Deferred.succeed(scanPaused, undefined).pipe(
          Effect.andThen(Deferred.await(continuation)),
        );
      };
      const scan = yield* service.asksRead({ all: true }).pipe(Effect.forkScoped);
      yield* Deferred.await(scanPaused);
      const answer = yield* service.answerAsk({
        threadId,
        id: "A1",
        text: "Reconnect.",
        runId: null,
      });
      expect(answer.n).toBe(1);
      yield* Fiber.interrupt(scan);
      expect(readThreads).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("requires handed_off while a ticket is open and reads its live state", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const input = {
      threadId,
      expectedRevision: 0,
      changes: [
        {
          id: "ticket",
          text: "Implement sample",
          state: "done" as const,
          links: [{ type: "ticket" as const, target: "BW-1" }],
        },
      ],
    };
    expect((yield* h.service.update(input, { by: "user" }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    yield* h.service.update(
      { ...input, changes: [{ ...input.changes[0]!, state: "handed_off" }] },
      { by: "user" },
    );
    expect((yield* h.service.get({ threadId })).items[0]?.linkStates?.[0]?.state).toBe("open");
    h.closeTicket();
    expect((yield* h.service.get({ threadId })).items[0]).toMatchObject({
      state: "handed_off",
      linkStates: [{ state: "closed", title: "Sample ticket" }],
    });
    const done = yield* h.service.update(
      {
        threadId,
        expectedRevision: 1,
        changes: [{ id: "ticket", state: "done" }],
      },
      { by: "user" },
    );
    expect(done.items[0]?.doneAt).not.toBeNull();
    h.reopenTicket();
    const reopened = yield* h.service.update(
      {
        threadId,
        expectedRevision: done.revision,
        changes: [{ id: "ticket", state: "handed_off" }],
      },
      { by: "user" },
    );
    expect(
      (yield* h.service
        .update(
          {
            threadId,
            expectedRevision: reopened.revision,
            changes: [{ id: "ticket", state: "done" }],
          },
          { by: "user" },
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("leaves a completed delegated lane handed_off for review", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const change = {
      id: "lane",
      text: "Review sample",
      state: "done" as const,
      links: [{ type: "thread" as const, target: "lane-thread" }],
    };
    expect(
      (yield* h.service
        .update({ threadId, expectedRevision: 0, changes: [change] }, { by: "user" })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [{ ...change, state: "handed_off" }],
      },
      { by: "user" },
    );
    h.finishLane();
    expect((yield* h.service.get({ threadId })).items[0]).toMatchObject({
      state: "handed_off",
      linkStates: [{ state: "needs_review", label: "completed" }],
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rewrites open items while retaining history and validates explicit ordering", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [
          { id: "open", text: "Old open" },
          { id: "done", text: "Finished", state: "done" },
          { id: "dropped", text: "Dropped", state: "dropped" },
          { id: "handoff", text: "Delegated", state: "handed_off" },
        ],
      },
      { by: "user" },
    );
    const next = yield* h.service.rewrite(
      {
        threadId,
        expectedRevision: 1,
        items: [{ id: "new", text: "Replacement" }],
      },
      { by: "user" },
    );
    expect(next.items.map((item) => item.id)).toEqual(["done", "dropped", "handoff", "new"]);
    expect(
      (yield* h.service
        .rewrite(
          {
            threadId,
            expectedRevision: 2,
            items: [{ id: "done", text: "Overwrite history" }],
          },
          { by: "user" },
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* h.service
        .update(
          { threadId, expectedRevision: 2, changes: [], order: ["new", "done"] },
          { by: "user" },
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const ordered = yield* h.service.update(
      {
        threadId,
        expectedRevision: 2,
        changes: [],
        order: ["new", "handoff", "dropped", "done"],
      },
      { by: "user" },
    );
    expect(ordered.items.map((item) => item.id)).toEqual(["new", "handoff", "dropped", "done"]);
    expect((yield* h.service.listRead({ threadId }))[0]?.items.map((item) => item.id)).toEqual([
      "new",
      "handoff",
    ]);
    const tree = yield* h.service.update(
      {
        threadId,
        expectedRevision: 3,
        changes: [
          { id: "root", text: "Open root" },
          { id: "finished-child", text: "Finished child", parentId: "root", state: "done" },
          {
            id: "finished-grandchild",
            text: "Finished grandchild",
            parentId: "finished-child",
            state: "dropped",
          },
          { id: "open-grandchild", text: "Open grandchild", parentId: "finished-child" },
        ],
      },
      { by: "user" },
    );
    const rewritten = yield* h.service.rewrite(
      {
        threadId,
        expectedRevision: tree.revision,
        items: [],
      },
      { by: "user" },
    );
    expect(rewritten.items.map((item) => item.id)).toEqual([
      "handoff",
      "dropped",
      "done",
      "finished-child",
      "finished-grandchild",
    ]);
    expect(rewritten.items.find((item) => item.id === "finished-child")).toMatchObject({
      state: "done",
      parentId: null,
    });
    expect(rewritten.items.find((item) => item.id === "finished-grandchild")).toMatchObject({
      state: "dropped",
      parentId: "finished-child",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps artifact versions and validates three list levels and artifact links", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.artifactWrite({
      threadId,
      expectedRevision: 0,
      id: "design",
      title: "Design",
      format: "markdown",
      content: "First",
    });
    yield* h.service.artifactWrite({
      threadId,
      expectedRevision: 1,
      id: "design",
      title: "Updated design",
      format: "markdown",
      content: "Second",
    });
    expect(yield* h.service.artifactRead({ threadId, id: "design", version: 1 })).toMatchObject({
      title: "Design",
      content: "First",
      version: 1,
    });
    expect(yield* h.service.artifactRead({ threadId, id: "design" })).toMatchObject({
      title: "Updated design",
      content: "Second",
      version: 2,
    });
    yield* h.service.update(
      {
        threadId,
        expectedRevision: 2,
        changes: [
          { id: "parent", text: "Parent", links: [{ type: "artifact", target: "design" }] },
          { id: "child", text: "Child", parentId: "parent" },
        ],
      },
      { by: "user" },
    );
    const nested = yield* h.service.update(
      {
        threadId,
        expectedRevision: 3,
        changes: [
          { id: "grandchild", text: "Grandchild", parentId: "child" },
          { id: "other", text: "Other root" },
        ],
      },
      { by: "user" },
    );
    for (const change of [
      { text: "Too deep", parentId: "grandchild" },
      { id: "parent", parentId: "grandchild" },
      { id: "parent", parentId: "parent" },
      { id: "child", parentId: "missing" },
      { id: "parent", parentId: "other" },
      { text: "Missing", links: [{ type: "artifact" as const, target: "absent" }] },
    ])
      expect(
        (yield* h.service
          .update(
            { threadId, expectedRevision: nested.revision, changes: [change] },
            { by: "user" },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    const moved = yield* h.service.update(
      {
        threadId,
        expectedRevision: nested.revision,
        changes: [{ id: "child", parentId: "other" }],
      },
      { by: "user" },
    );
    expect(moved.items.find((item) => item.id === "grandchild")?.parentId).toBe("child");
    const completed = yield* h.service.update(
      {
        threadId,
        expectedRevision: moved.revision,
        changes: [{ id: "other", state: "done" }],
      },
      { by: "user" },
    );
    const dropped = yield* h.service.update(
      {
        threadId,
        expectedRevision: completed.revision,
        changes: [{ id: "other", state: "dropped" }],
      },
      { by: "user" },
    );
    expect(
      dropped.items
        .filter((item) => ["child", "grandchild"].includes(item.id))
        .map((item) => item.state),
    ).toEqual(["open", "open"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "keeps draft answers private, sends selected answers once and carries only unchanged questions",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const question = {
        id: "mode",
        prompt: "Choose mode",
        options: [{ id: "safe", label: "Safe", description: "Checks input" }],
        recommendedOptionIds: ["safe"],
        multiSelect: false,
      };
      const content = `# Plan\n\n\`\`\`t3-question\n${JSON.stringify(question)}\n\`\`\``;
      yield* h.service.artifactWrite({
        threadId,
        expectedRevision: 0,
        id: "plan",
        title: "Plan",
        format: "markdown",
        content,
      });
      yield* h.service.artifactAnswer({
        threadId,
        expectedRevision: 1,
        id: "plan",
        version: 1,
        answers: { mode: { chosenOptionIds: ["safe"], notes: "Private note", submittedAt: null } },
      });
      expect((yield* h.service.artifactRead({ threadId, id: "plan" })).answers).toEqual({});
      expect((yield* h.service.artifactList({ threadId }))[0]?.unansweredQuestions).toBe(1);
      expect(
        (yield* h.service.get({ threadId })).artifacts[0]?.versions[0]?.answers.mode?.notes,
      ).toBe("Private note");
      const submitted = yield* h.service.artifactSubmit({
        threadId,
        expectedRevision: 2,
        id: "plan",
        version: 1,
        questionIds: ["mode"],
      });
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]?.origin).toEqual({ kind: "user" });
      expect((yield* h.service.artifactList({ threadId }))[0]?.unansweredQuestions).toBe(0);
      expect(h.sends[0]?.context?.records).toEqual([
        expect.objectContaining({
          kind: "artifact-answer",
          artifactId: "plan",
          version: 1,
          question: "Choose mode",
          choice: "Safe",
          note: "Private note",
        }),
      ]);
      expect(
        (yield* h.service.artifactRead({ threadId, id: "plan" })).answers.mode?.submittedAt,
      ).not.toBeNull();
      const retried = yield* h.service.artifactSubmit({
        threadId,
        expectedRevision: submitted.revision,
        id: "plan",
        version: 1,
        questionIds: ["mode"],
      });
      expect(retried.revision).toBe(submitted.revision);
      expect(h.sends).toHaveLength(1);
      const otherThread = ThreadId.make("other-thread");
      yield* h.service.artifactWrite({
        threadId: otherThread,
        expectedRevision: 0,
        id: "plan",
        title: "Plan",
        format: "markdown",
        content,
      });
      yield* h.service.artifactAnswer({
        threadId: otherThread,
        expectedRevision: 1,
        id: "plan",
        version: 1,
        answers: { mode: { chosenOptionIds: ["safe"], notes: "Private note", submittedAt: null } },
      });
      yield* h.service.artifactSubmit({
        threadId: otherThread,
        expectedRevision: 2,
        id: "plan",
        version: 1,
        questionIds: ["mode"],
      });
      expect(h.sends).toHaveLength(2);
      expect(h.sends[1]?.commandId).not.toBe(h.sends[0]?.commandId);
      expect(h.sends[1]?.messageId).not.toBe(h.sends[0]?.messageId);
      const draftAgain = yield* h.service.artifactAnswer({
        threadId,
        expectedRevision: retried.revision,
        id: "plan",
        version: 1,
        answers: { mode: { chosenOptionIds: ["safe"], notes: "Private note", submittedAt: null } },
      });
      const resubmitted = yield* h.service.artifactSubmit({
        threadId,
        expectedRevision: draftAgain.revision,
        id: "plan",
        version: 1,
        questionIds: ["mode"],
      });
      expect(h.sends).toHaveLength(3);
      expect(h.sends[2]?.commandId).not.toBe(h.sends[0]?.commandId);
      const second = yield* h.service.artifactWrite({
        threadId,
        expectedRevision: resubmitted.revision,
        id: "plan",
        title: "Plan",
        format: "markdown",
        content: `More prose\n\n${content}`,
      });
      expect(second.artifacts[0]?.versions[1]?.answers.mode?.submittedAt).not.toBeNull();
      const third = yield* h.service.artifactWrite({
        threadId,
        expectedRevision: second.revision,
        id: "plan",
        title: "Plan",
        format: "markdown",
        content: content.replace("Choose mode", "Choose a new mode"),
      });
      expect(third.artifacts[0]?.versions[2]?.answers).toEqual({});
      const queued = yield* h.service.artifactAnswer({
        threadId,
        expectedRevision: third.revision,
        id: "plan",
        version: 3,
        answers: {
          mode: {
            chosenOptionIds: ["safe"],
            notes: "Only sent notes become public",
            submittedAt: null,
          },
        },
      });
      const record = {
        version: 1 as const,
        kind: "artifact-answer" as const,
        contextId: ComposerContextId.make("queued-answer"),
        label: "Plan",
        artifactId: "plan",
        artifactVersion: 3,
        questionId: "mode",
        answerRevision: queued.revision,
        title: "Plan",
        question: "Choose a new mode",
        choice: "Safe",
        note: "Only sent notes become public",
      };
      expect((yield* h.service.artifactRead({ threadId, id: "plan" })).answers).toEqual({});
      h.messages.push({
        id: MessageId.make("sent-answer"),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        origin: { kind: "user" },
        createdBy: "user",
        creationSource: "web",
        text: "Attached answer",
        context: { version: 1, records: [record] },
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      });
      expect(
        (yield* h.service.artifactRead({ threadId, id: "plan" })).answers.mode?.submittedAt,
      ).toBe(DateTime.formatIso(at));
      const redrafted = yield* h.service.artifactAnswer({
        threadId,
        expectedRevision: queued.revision,
        id: "plan",
        version: 3,
        answers: { mode: { chosenOptionIds: ["safe"], notes: record.note, submittedAt: null } },
      });
      expect(redrafted.artifacts[0]?.versions[2]?.answers.mode?.draftRevision).toBe(
        redrafted.revision,
      );
      expect((yield* h.service.artifactRead({ threadId, id: "plan" })).answers).toEqual({});

      expect((yield* h.service.artifactList({ threadId }))[0]?.unansweredQuestions).toBe(1);
      expect(
        (yield* h.service.artifactRead({ threadId, id: "plan", version: 1 })).answers.mode?.notes,
      ).toBe("Private note");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const choice = (id: string, label: string) => ({ id, label });
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.flip);

it.effect("moves questions through their states with ids that are never reused", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ask = (prompt: string, replaces?: string) =>
      h.service.questionAsk({
        threadId,
        questions: [
          {
            prompt,
            options: [choice("pg", "Postgres"), choice("lite", "SQLite")],
            ...(replaces === undefined ? {} : { replaces }),
          },
        ],
      });
    const update = (
      id: string,
      state: "open" | "deferred" | "answered" | "withdrawn",
      by: "user" | "agent" = "agent",
      answer?: { chosenOptionIds?: string[]; notes?: string },
    ) =>
      h.service.questionUpdate(
        { threadId, id, state, ...(answer === undefined ? {} : { answer }) },
        by,
      );
    const asked = yield* h.service.questionAsk({
      threadId,
      questions: [
        { prompt: "Which database should the cache use for local development?" },
        { prompt: "Ship behind a flag?" },
      ],
    });
    expect(asked.questions.map((question) => [question.id, question.state])).toEqual([
      ["Q1", "open"],
      ["Q2", "open"],
    ]);
    expect(yield* h.mirrored()).toEqual([
      {
        kind: "question",
        ref: "Q1",
        key: "Q1",
        title: "Which database should the cache use for local…",
        state: "open",
      },
      { kind: "question", ref: "Q2", key: "Q2", title: "Ship behind a flag?", state: "open" },
    ]);
    yield* update("Q1", "deferred", "user");
    expect((yield* h.mirrored()).map((question) => question.state)).toEqual(["deferred", "open"]);
    expect((yield* h.mirrored())[0]?.userChangedAt).toBeDefined();
    yield* update("Q1", "open", "agent");
    expect((yield* h.mirrored())[0]).not.toHaveProperty("userChangedAt");
    const answered = yield* update("Q2", "answered", "agent", { notes: "Yes, default off" });
    expect(answered.questions[1]).toMatchObject({
      state: "answered",
      answeredBy: "agent",
      answer: { chosenOptionIds: [], notes: "Yes, default off" },
    });
    expect(answered.questions[1]?.closedAt).not.toBeNull();
    yield* update("Q1", "withdrawn", "user");
    // Kept so the agent's next user-message turn hears the user dismissed it.
    expect(yield* h.mirrored()).toEqual([
      {
        kind: "question",
        ref: "Q1",
        key: "Q1",
        title: expect.any(String),
        state: "dismissed",
        settledBy: "user",
        userChangedAt: expect.any(String),
      },
    ]);
    const reopened = yield* update("Q2", "open", "user");
    expect(reopened.questions[1]).toMatchObject({
      state: "open",
      closedAt: null,
      answeredBy: null,
      answer: { notes: "Yes, default off", submittedAt: null },
    });
    yield* ask("Which database?");
    const replaced = yield* ask("Which database, now that SQLite is out?", "Q3");
    expect(replaced.questions.map((question) => [question.id, question.state])).toEqual([
      ["Q1", "withdrawn"],
      ["Q2", "open"],
      ["Q3", "replaced"],
      ["Q4", "open"],
    ]);
    expect(replaced.questions[2]?.replacedBy).toBe("Q4");
    expect((yield* h.mirrored()).map((question) => question.ref)).toEqual(["Q1", "Q2", "Q4"]);

    for (const [attempt, code] of [
      [update("Q1", "withdrawn"), "invalid"],
      [update("Q1", "answered", "agent", { notes: "late" }), "invalid"],
      [update("Q4", "open"), "invalid"],
      [update("Q4", "answered", "agent"), "invalid"],
      [update("Q4", "answered", "agent", { notes: "  " }), "invalid"],
      [update("Q4", "answered", "agent", { chosenOptionIds: ["mysql"] }), "invalid"],
      [update("Q4", "answered", "agent", { chosenOptionIds: ["pg", "lite"] }), "invalid"],
      [update("Q4", "answered", "user", { notes: "Postgres" }), "invalid"],
      [update("Q9", "withdrawn"), "not_found"],
      [ask("Again?", "Q9"), "not_found"],
      [ask("Again?", "Q3"), "invalid"],
      [
        h.service.questionAsk({
          threadId,
          questions: [{ prompt: "Pick", options: [choice("a", "A")], recommendedOptionIds: ["b"] }],
        }),
        "invalid",
      ],
    ] as const)
      expect((yield* failureOf(attempt)).code).toBe(code);
    yield* update("Q4", "deferred", "user");
    expect((yield* failureOf(update("Q4", "deferred", "user"))).code).toBe("invalid");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const answerRecord = (
  questionId: string,
  answerRevision: number,
  choice = "",
  note = "",
  artifactId: string = THREAD_QUESTIONS_ARTIFACT_ID,
) => ({
  version: 1 as const,
  kind: "artifact-answer" as const,
  contextId: ComposerContextId.make(`answer_${questionId}_${answerRevision}`),
  label: questionId,
  artifactId,
  questionId,
  answerRevision,
  title: questionId,
  artifactVersion: 1,
  question: questionId,
  choice,
  note,
});
const userMessage = (
  id: string,
  records: ReadonlyArray<ReturnType<typeof answerRecord>>,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  role: "user",
  createdBy: "user",
  creationSource: "web",
  origin: { kind: "user" },
  text: "Answers",
  context: { version: 1, records: [...records] },
  attachments: [],
  streaming: false,
  createdAt: at,
  updatedAt: at,
});
const threadRun = (
  id: string,
  userMessageId: string,
  status: OrchestrationV2Run["status"],
  extra: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default" },
  providerThreadId: null,
  userMessageId: MessageId.make(userMessageId),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at,
  startedAt: status === "queued" ? null : at,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...extra,
});

it.effect("counts an answer a queued message carries as sent until its turn starts", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({
      threadId,
      questions: [
        { prompt: "Database?", options: [choice("pg", "Postgres"), choice("lite", "SQLite")] },
        { prompt: "Name of the flag?" },
        { prompt: "Release this week?" },
      ],
    });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: {
        Q1: { chosenOptionIds: ["pg"], notes: "" },
        Q2: { chosenOptionIds: [], notes: "cache-v2" },
      },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    const sentState = () =>
      h
        .mirrored()
        .pipe(
          Effect.map((questions) =>
            questions.map((question) => [question.ref, question.sent === true]),
          ),
        );

    h.messages.push(userMessage("m1", [answerRecord("Q1", revision, "Postgres")]));
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    const queued = yield* h.service.get({ threadId });
    expect(queued.questions[0]).toMatchObject({ state: "open", sentInMessageId: "m1" });
    expect(yield* sentState()).toEqual([
      ["Q1", true],
      ["Q2", false],
      ["Q3", false],
    ]);
    expect(
      (yield* failureOf(
        h.service.questionDraft({ threadId, answers: { Q1: { chosenOptionIds: [], notes: "" } } }),
      )).code,
    ).toBe("invalid");

    // Cancelled before it started: the question waits on the user again, draft intact.
    h.threadRuns[0] = threadRun("r1", "m1", "cancelled", { startedAt: null });
    const cancelled = yield* h.service.get({ threadId });
    expect(cancelled.questions[0]).not.toHaveProperty("sentInMessageId");
    expect(cancelled.questions[0]?.answer?.chosenOptionIds).toEqual(["pg"]);
    expect((yield* sentState())[0]).toEqual(["Q1", false]);

    // Sent again with Q2, then edited in the queue so Q2 no longer rides it.
    h.messages.push(
      userMessage("m2", [
        answerRecord("Q1", revision, "Postgres"),
        answerRecord("Q2", revision, "", "cache-v2"),
      ]),
    );
    h.threadRuns.push(threadRun("r2", "m2", "queued"));
    yield* h.service.get({ threadId });
    expect((yield* sentState()).slice(0, 2)).toEqual([
      ["Q1", true],
      ["Q2", true],
    ]);
    h.messages[1] = userMessage("m2", [answerRecord("Q1", revision, "Postgres")]);
    yield* h.service.get({ threadId });
    expect((yield* sentState()).slice(0, 2)).toEqual([
      ["Q1", true],
      ["Q2", false],
    ]);

    // The provider accepts its turn: the agent received Q1, which closes as answered by the user.
    h.threadRuns[1] = threadRun("r2", "m2", "running");
    h.acceptTurn("r2");
    const received = yield* h.service.get({ threadId });
    expect(received.questions[0]).toMatchObject({
      state: "answered",
      answeredBy: "user",
      sentInMessageId: "m2",
      answer: { chosenOptionIds: ["pg"], submittedAt: expect.any(String) },
    });
    expect((yield* h.mirrored()).map((question) => question.ref)).toEqual(["Q2", "Q3"]);
    const again = yield* h.service.get({ threadId });
    expect(again.questions[0]).toEqual(received.questions[0]);
    const recorded = yield* h.service.questionUpdate(
      { threadId, id: "Q1", state: "answered", answer: { chosenOptionIds: ["lite"] } },
      "agent",
    );
    expect(recorded.questions[0]).toEqual(received.questions[0]);

    // Reopened, the same message no longer carries its new draft revision.
    const reopened = yield* h.service.questionUpdate({ threadId, id: "Q1", state: "open" }, "user");
    expect(reopened.questions[0]).not.toHaveProperty("sentInMessageId");
    expect((yield* h.service.get({ threadId })).questions[0]?.state).toBe("open");
    expect((yield* sentState())[0]).toEqual(["Q1", false]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("closes an answer only once a provider has accepted the turn carrying it", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({
      threadId,
      questions: [{ prompt: "Database?", options: [choice("pg", "Postgres")] }],
    });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: ["pg"], notes: "" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    const sentState = () =>
      h
        .mirrored()
        .pipe(Effect.map((questions) => questions.map((question) => question.sent === true)));
    h.messages.push(userMessage("m1", [answerRecord("Q1", revision, "Postgres")]));
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    // The save is refused even before any read has marked the answer sent.
    expect(
      (yield* failureOf(
        h.service.questionDraft({ threadId, answers: { Q1: { chosenOptionIds: [], notes: "" } } }),
      )).code,
    ).toBe("invalid");
    h.threadRuns[0] = threadRun("r1", "m1", "starting", { startedAt: null });
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      state: "open",
      sentInMessageId: "m1",
    });
    // The running write lands, with a start time, before the start service calls the adapter.
    h.threadRuns[0] = threadRun("r1", "m1", "running");
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      state: "open",
      sentInMessageId: "m1",
    });
    expect(yield* sentState()).toEqual([true]);
    // The adapter refuses the start: no provider turn, so the agent never got the answer.
    h.threadRuns[0] = threadRun("r1", "m1", "failed");
    const refused = yield* h.service.get({ threadId });
    expect(refused.questions[0]).toMatchObject({
      state: "open",
      answer: { chosenOptionIds: ["pg"], submittedAt: null },
    });
    expect(refused.questions[0]).not.toHaveProperty("sentInMessageId");
    expect(yield* sentState()).toEqual([false]);
    // Sent again, and this time the provider accepts the turn.
    h.messages.push(userMessage("m2", [answerRecord("Q1", revision, "Postgres")]));
    h.threadRuns.push(threadRun("r2", "m2", "running"));
    h.acceptTurn("r2");
    const received = yield* h.service.get({ threadId });
    expect(received.questions[0]).toMatchObject({
      state: "answered",
      answeredBy: "user",
      sentInMessageId: "m2",
    });
    expect(yield* h.mirrored()).toEqual([]);
    expect((yield* h.service.get({ threadId })).questions[0]).toEqual(received.questions[0]);
    // Accepted, then failed later: the agent had the answer, so it stays received.
    h.threadRuns[1] = threadRun("r2", "m2", "failed");
    expect((yield* h.service.get({ threadId })).questions[0]).toEqual(received.questions[0]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "ignores a queued message edited to carry a different answer under the same revision",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.questionAsk({
        threadId,
        questions: [
          { prompt: "Database?", options: [choice("pg", "Postgres"), choice("lite", "SQLite")] },
        ],
      });
      const drafted = yield* h.service.questionDraft({
        threadId,
        answers: { Q1: { chosenOptionIds: ["pg"], notes: "" } },
      });
      const revision = drafted.questions[0]!.answer!.draftRevision!;
      h.messages.push(userMessage("m1", [answerRecord("Q1", revision, "SQLite")]));
      h.threadRuns.push(threadRun("r1", "m1", "running"));
      const read = yield* h.service.get({ threadId });
      expect(read.questions[0]).toMatchObject({ state: "open", answeredBy: null });
      expect(read.questions[0]).not.toHaveProperty("sentInMessageId");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("shows a deferred question the user discusses as discussing and still deferred", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({
      threadId,
      questions: [{ prompt: "Database?", options: [choice("pg", "Postgres")] }],
    });
    yield* h.service.questionUpdate({ threadId, id: "Q1", state: "deferred" }, "user");
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "Would it survive two writers?" } },
    });
    expect(drafted.questions[0]?.state).toBe("deferred");
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    h.messages.push(
      userMessage("m1", [
        answerRecord(
          "Q1",
          revision,
          "",
          "Would it survive two writers?",
          THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
        ),
      ]),
    );
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    expect(yield* h.mirrored()).toEqual([
      {
        kind: "question",
        ref: "Q1",
        key: "Q1",
        title: "Database?",
        state: "discussing",
        deferred: true,
        userChangedAt: expect.any(String),
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps a question waiting and counted when a message only discusses it", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({
      threadId,
      questions: [{ prompt: "Database?", options: [choice("pg", "Postgres")] }],
    });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: ["pg"], notes: "Would it survive two writers?" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    h.messages.push(
      userMessage("m1", [
        answerRecord(
          "Q1",
          revision,
          "",
          "Would it survive two writers?",
          THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
        ),
      ]),
    );
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    const queued = yield* h.service.get({ threadId });
    expect(queued.questions[0]).not.toHaveProperty("sentInMessageId");
    expect(queued.questions[0]).toMatchObject({
      discussedInMessageId: "m1",
      answer: { notes: "Would it survive two writers?" },
    });
    expect(yield* h.mirrored()).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Database?", state: "discussing" },
    ]);
    // Running but not yet accepted by a provider: the note stays.
    h.threadRuns[0] = threadRun("r1", "m1", "running");
    expect((yield* h.service.get({ threadId })).questions[0]?.answer?.notes).toBe(
      "Would it survive two writers?",
    );
    // Accepted: the comment has gone, so its note clears; the chosen option stays a draft.
    h.acceptTurn("r1");
    const started = yield* h.service.get({ threadId });
    expect(started.questions[0]).toMatchObject({
      state: "open",
      answeredBy: null,
      discussedInMessageId: "m1",
      answer: { chosenOptionIds: ["pg"], notes: "", submittedAt: null },
    });
    expect((yield* h.service.get({ threadId })).questions[0]).toEqual(started.questions[0]);
    expect(yield* h.mirrored()).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Database?", state: "discussing" },
    ]);
    // A new draft ends the discussion, and the old comment never restarts it.
    const redrafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "" } },
    });
    expect(redrafted.questions[0]).not.toHaveProperty("discussedInMessageId");
    expect((yield* h.service.get({ threadId })).questions[0]).not.toHaveProperty(
      "discussedInMessageId",
    );
    expect(yield* h.mirrored()).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Database?", state: "open" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps a comment's note until its turn starts, and drops one edited in the queue", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const comment = (id: string, revision: number, note: string) =>
      userMessage(id, [
        answerRecord("Q1", revision, "", note, THREAD_QUESTION_COMMENTS_ARTIFACT_ID),
      ]);
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "Why not cache-v1?" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    // Cancelled before it started: no discussion, the note is intact.
    h.messages.push(comment("m1", revision, "Why not cache-v1?"));
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      discussedInMessageId: "m1",
    });
    h.threadRuns[0] = threadRun("r1", "m1", "cancelled", { startedAt: null });
    const cancelled = yield* h.service.get({ threadId });
    expect(cancelled.questions[0]).not.toHaveProperty("discussedInMessageId");
    expect(cancelled.questions[0]?.answer?.notes).toBe("Why not cache-v1?");
    // Sent again, then edited in the queue: it no longer carries the draft, so it discusses nothing.
    h.messages.push(comment("m2", revision, "Why not cache-v1?"));
    h.threadRuns.push(threadRun("r2", "m2", "queued"));
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      discussedInMessageId: "m2",
    });
    h.messages[1] = comment("m2", revision, "Why not cache-v1, really?");
    expect((yield* h.service.get({ threadId })).questions[0]).not.toHaveProperty(
      "discussedInMessageId",
    );
    // Accepted, but the queued text no longer matches the note: the note stays.
    h.threadRuns[1] = threadRun("r2", "m2", "running");
    h.acceptTurn("r2");
    const received = yield* h.service.get({ threadId });
    expect(received.questions[0]).not.toHaveProperty("discussedInMessageId");
    expect(received.questions[0]?.answer?.notes).toBe("Why not cache-v1?");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("lets an answer queued after a comment keep its note, in either acceptance order", () =>
  Effect.gen(function* () {
    for (const order of ["comment first", "both at once"] as const) {
      const h = yield* harness();
      yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
      const drafted = yield* h.service.questionDraft({
        threadId,
        answers: { Q1: { chosenOptionIds: [], notes: "cache-v2" } },
      });
      const revision = drafted.questions[0]!.answer!.draftRevision!;
      h.messages.push(
        userMessage("m1", [
          answerRecord("Q1", revision, "", "cache-v2", THREAD_QUESTION_COMMENTS_ARTIFACT_ID),
        ]),
        userMessage("m2", [answerRecord("Q1", revision, "", "cache-v2")]),
      );
      h.threadRuns.push(threadRun("r1", "m1", "queued"), threadRun("r2", "m2", "queued"));
      if (order === "comment first") {
        h.threadRuns[0] = threadRun("r1", "m1", "running");
        h.acceptTurn("r1");
        const sent = yield* h.service.get({ threadId });
        expect(sent.questions[0]).toMatchObject({
          state: "open",
          sentInMessageId: "m2",
          answer: { notes: "cache-v2" },
        });
        expect((yield* h.service.get({ threadId })).questions[0]).toEqual(sent.questions[0]);
      } else h.acceptTurn("r1");
      h.threadRuns[1] = threadRun("r2", "m2", "running");
      h.acceptTurn("r2");
      expect((yield* h.service.get({ threadId })).questions[0], order).toMatchObject({
        state: "answered",
        answeredBy: "user",
        sentInMessageId: "m2",
        answer: { notes: "cache-v2", submittedAt: expect.any(String) },
      });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps a queued answer sent when the user defers before any scan saw it", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "cache-v2" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    h.messages.push(userMessage("m1", [answerRecord("Q1", revision, "", "cache-v2")]));
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    const deferred = yield* h.service.questionUpdate(
      { threadId, id: "Q1", state: "deferred" },
      "user",
    );
    expect(deferred.questions[0]).toMatchObject({
      state: "deferred",
      sentInMessageId: "m1",
      answer: { draftRevision: revision },
    });
    h.threadRuns[0] = threadRun("r1", "m1", "running");
    h.acceptTurn("r1");
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      state: "answered",
      answeredBy: "user",
      sentInMessageId: "m1",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reopens a deferred question whose answer is queued without unsending it", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "cache-v2" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    yield* h.service.questionUpdate({ threadId, id: "Q1", state: "deferred" }, "user");
    h.messages.push(userMessage("m1", [answerRecord("Q1", revision + 1, "", "cache-v2")]));
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      state: "deferred",
      sentInMessageId: "m1",
    });
    const reopened = yield* h.service.questionUpdate({ threadId, id: "Q1", state: "open" }, "user");
    expect(reopened.questions[0]).toMatchObject({
      state: "open",
      sentInMessageId: "m1",
      answer: { draftRevision: revision + 1 },
    });
    h.threadRuns[0] = threadRun("r1", "m1", "running");
    h.acceptTurn("r1");
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      state: "answered",
      answeredBy: "user",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps the note of a comment deferred before its turn starts", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "Why?" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    h.messages.push(
      userMessage("m1", [
        answerRecord("Q1", revision, "", "Why?", THREAD_QUESTION_COMMENTS_ARTIFACT_ID),
      ]),
    );
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      discussedInMessageId: "m1",
    });
    const deferred = yield* h.service.questionUpdate(
      { threadId, id: "Q1", state: "deferred" },
      "user",
    );
    expect(deferred.questions[0]).not.toHaveProperty("discussedInMessageId");
    h.threadRuns[0] = threadRun("r1", "m1", "running");
    h.acceptTurn("r1");
    const later = yield* h.service.get({ threadId });
    expect(later.questions[0]).not.toHaveProperty("discussedInMessageId");
    expect(later.questions[0]).toMatchObject({ state: "deferred", answer: { notes: "Why?" } });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("ends a discussion when the agent replaces the question", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "Why?" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    h.messages.push(
      userMessage("m1", [
        answerRecord("Q1", revision, "", "Why?", THREAD_QUESTION_COMMENTS_ARTIFACT_ID),
      ]),
    );
    h.threadRuns.push(threadRun("r1", "m1", "running"));
    h.acceptTurn("r1");
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      discussedInMessageId: "m1",
      answer: { notes: "" },
    });
    const replaced = yield* h.service.questionAsk({
      threadId,
      questions: [{ prompt: "Flag name, given the cache split?", replaces: "Q1" }],
    });
    expect(replaced.questions.map((question) => [question.id, question.state])).toEqual([
      ["Q1", "replaced"],
      ["Q2", "open"],
    ]);
    expect(replaced.questions[0]).not.toHaveProperty("discussedInMessageId");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("discusses a user's answer the agent reopens until the agent acts on it", () =>
  Effect.gen(function* () {
    for (const end of ["replaced", "answered", "withdrawn"] as const) {
      const h = yield* harness();
      yield* h.service.questionAsk({
        threadId,
        questions: [{ prompt: "Database?", options: [choice("pg", "Postgres")] }],
      });
      const drafted = yield* h.service.questionDraft({
        threadId,
        answers: { Q1: { chosenOptionIds: ["pg"], notes: "Does it need a server?" } },
      });
      const revision = drafted.questions[0]!.answer!.draftRevision!;
      h.messages.push(
        userMessage("m1", [answerRecord("Q1", revision, "Postgres", "Does it need a server?")]),
      );
      h.threadRuns.push(threadRun("r1", "m1", "running"));
      h.acceptTurn("r1");
      expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
        state: "answered",
        answeredBy: "user",
        sentInMessageId: "m1",
      });
      const reopened = yield* h.service.questionUpdate(
        { threadId, id: "Q1", state: "open" },
        "agent",
      );
      expect(reopened.questions[0]).toMatchObject({
        state: "open",
        discussedInMessageId: "m1",
        answer: { chosenOptionIds: ["pg"], notes: "Does it need a server?", submittedAt: null },
      });
      expect(reopened.questions[0]).not.toHaveProperty("sentInMessageId");
      const later = yield* h.service.get({ threadId });
      expect(later.questions[0]).toEqual(reopened.questions[0]);
      expect(yield* h.mirrored()).toEqual([
        { kind: "question", ref: "Q1", key: "Q1", title: "Database?", state: "discussing" },
      ]);
      const ended =
        end === "replaced"
          ? yield* h.service.questionAsk({
              threadId,
              questions: [{ prompt: "Database, given a server?", replaces: "Q1" }],
            })
          : yield* h.service.questionUpdate(
              {
                threadId,
                id: "Q1",
                state: end,
                ...(end === "answered"
                  ? { answer: { chosenOptionIds: ["pg"], notes: "Postgres with a server" } }
                  : {}),
              },
              "agent",
            );
      expect(ended.questions[0]?.state, end).toBe(end);
      expect(ended.questions[0], end).not.toHaveProperty("discussedInMessageId");
      expect(yield* h.mirrored(), end).not.toContainEqual(expect.objectContaining({ ref: "Q1" }));
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("starts no discussion when the user reopens, or the agent reopens its own record", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({
      threadId,
      questions: [{ prompt: "Flag name?" }, { prompt: "Cache size?" }, { prompt: "Region?" }],
    });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "cache-v2, but why?" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    h.messages.push(userMessage("m1", [answerRecord("Q1", revision, "", "cache-v2, but why?")]));
    h.threadRuns.push(threadRun("r1", "m1", "running"));
    h.acceptTurn("r1");
    yield* h.service.get({ threadId });
    yield* h.service.questionUpdate(
      { threadId, id: "Q2", state: "answered", answer: { chosenOptionIds: [], notes: "64 MB" } },
      "agent",
    );
    yield* h.service.questionUpdate({ threadId, id: "Q3", state: "deferred" }, "user");
    yield* h.service.questionUpdate({ threadId, id: "Q1", state: "open" }, "user");
    yield* h.service.questionUpdate({ threadId, id: "Q2", state: "open" }, "agent");
    const reopened = yield* h.service.questionUpdate(
      { threadId, id: "Q3", state: "open" },
      "agent",
    );
    for (const question of reopened.questions) {
      expect(question.state, question.id).toBe("open");
      expect(question, question.id).not.toHaveProperty("discussedInMessageId");
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("follows messages and runs so a sent answer leaves the count without a read", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "cache-v2" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    yield* h.mirrored();
    yield* Queue.clear(h.changed);
    yield* Effect.forkScoped(h.service.followQuestionDeliveries);
    const message = userMessage("m1", [answerRecord("Q1", revision, "", "cache-v2")]);
    h.messages.push(message);
    h.threadRuns.push(threadRun("r1", "m1", "queued"));
    yield* Queue.offer(h.domainEvents, {
      type: "run.updated",
      threadId,
      payload: h.threadRuns[0],
    } as unknown as OrchestrationV2DomainEvent);
    yield* Queue.offer(h.domainEvents, {
      type: "message.updated",
      threadId,
      payload: message,
    } as unknown as OrchestrationV2DomainEvent);
    yield* Queue.take(h.changed);
    expect(yield* h.mirrored()).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Flag name?", state: "open", sent: true },
    ]);
    h.threadRuns[0] = threadRun("r1", "m1", "cancelled", { startedAt: null });
    yield* Queue.offer(h.domainEvents, {
      type: "run.updated",
      threadId,
      payload: h.threadRuns[0],
    } as unknown as OrchestrationV2DomainEvent);
    yield* Queue.take(h.changed);
    expect(yield* h.mirrored()).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Flag name?", state: "open" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("follows a provider accepting a turn when nothing else reports it", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "cache-v2" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    yield* h.mirrored();
    yield* Queue.clear(h.changed);
    yield* Effect.forkScoped(h.service.followQuestionDeliveries);
    const message = userMessage("m1", [answerRecord("Q1", revision, "", "cache-v2")]);
    h.messages.push(message);
    h.threadRuns.push(threadRun("r1", "m1", "running"));
    yield* Queue.offer(h.domainEvents, {
      type: "message.updated",
      threadId,
      payload: message,
    } as unknown as OrchestrationV2DomainEvent);
    yield* Queue.take(h.changed);
    expect(yield* h.mirrored()).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Flag name?", state: "open", sent: true },
    ]);
    h.acceptTurn("r1");
    yield* Queue.offer(h.domainEvents, {
      type: "provider-turn.updated",
      threadId,
      payload: {},
    } as unknown as OrchestrationV2DomainEvent);
    yield* Queue.take(h.changed);
    expect(yield* h.mirrored()).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("follows a sent answer's turn while more than 30 other items wait in the thread", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Flag name?" }] });
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q1: { chosenOptionIds: [], notes: "cache-v2" } },
    });
    const revision = drafted.questions[0]!.answer!.draftRevision!;
    h.messages.push(userMessage("m1", [answerRecord("Q1", revision, "", "cache-v2")]));
    h.threadRuns.push(threadRun("r1", "m1", "running"));
    const sent = yield* h.mirrored();
    expect(sent).toMatchObject([{ ref: "Q1", sent: true }]);
    // The thread's stored mirror, as the orchestrator keeps it with 31 tasks waiting.
    h.mirror.waiting = waitingMirror([
      ...Array.from({ length: 31 }, (_, index) => ({
        kind: "task" as const,
        ref: `T${index + 1}`,
        key: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        state: "open" as const,
      })),
      ...sent,
    ]).waiting;
    yield* Queue.clear(h.changed);
    yield* Effect.forkScoped(h.service.followQuestionDeliveries);
    h.acceptTurn("r1");
    yield* Queue.offer(h.domainEvents, {
      type: "provider-turn.updated",
      threadId,
      payload: {},
    } as unknown as OrchestrationV2DomainEvent);
    // The provider accepted the turn, so the answer closes and leaves the mirror.
    yield* Queue.take(h.changed);
    expect((yield* h.service.get({ threadId })).questions[0]?.state).toBe("answered");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("names the user message an agent recorded an answer from, and only that one", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({
      threadId,
      questions: [
        { prompt: "Which team owns the staging alerts channel?" },
        { prompt: "Database?", options: [choice("pg", "Postgres")] },
        { prompt: "Ship behind a flag?" },
      ],
    });
    const record = (id: string, notes: string) =>
      h.service.questionUpdate({ threadId, id, state: "answered", answer: { notes } }, "agent");
    // Answered in prose: the agent records it in the turn the user's message started, the one
    // user message since the question was asked.
    h.turnMessage.current = MessageId.make("m-prose");
    const recorded = yield* record("Q1", "Platform owns it");
    expect(recorded.questions[0]).toMatchObject({
      state: "answered",
      answeredBy: "agent",
      settledFromMessageId: "m-prose",
    });
    expect(h.turnMessage.anchors).toEqual([recorded.questions[0]!.createdAt]);
    // The user answered, then sent another message, and the agent records the answer in that
    // later turn: two user messages since the question, so it names neither.
    h.turnMessage.current = MessageId.make("m-unrelated");
    h.turnMessage.sole = false;
    expect((yield* record("Q3", "Later")).questions[2]).toMatchObject({
      state: "answered",
      answeredBy: "agent",
    });
    expect((yield* h.service.get({ threadId })).questions[2]).not.toHaveProperty(
      "settledFromMessageId",
    );
    yield* h.service.questionUpdate({ threadId, id: "Q3", state: "open" }, "agent");
    h.turnMessage.sole = true;
    // Reopened, the answer goes and so does the message it came from.
    const reopened = yield* h.service.questionUpdate(
      { threadId, id: "Q1", state: "open" },
      "agent",
    );
    expect(reopened.questions[0]).not.toHaveProperty("settledFromMessageId");
    // A turn no user message started names none.
    h.turnMessage.current = null;
    expect((yield* record("Q3", "Yes")).questions[2]).not.toHaveProperty("settledFromMessageId");
    // The user's own answer through the card already names the message that carried it.
    const drafted = yield* h.service.questionDraft({
      threadId,
      answers: { Q2: { chosenOptionIds: ["pg"], notes: "" } },
    });
    const revision = drafted.questions[1]!.answer!.draftRevision!;
    h.messages.push(userMessage("m1", [answerRecord("Q2", revision, "Postgres")]));
    h.threadRuns.push(threadRun("r1", "m1", "running"));
    h.acceptTurn("r1");
    h.turnMessage.current = MessageId.make("m1");
    const after = (yield* record("Q2", "Postgres")).questions[1];
    expect(after).toMatchObject({ answeredBy: "user", sentInMessageId: "m1" });
    expect(after).not.toHaveProperty("settledFromMessageId");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("numbers the user's tasks once and lists them with questions as waiting items", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const created = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [
          { text: "Rotate the staging webhook secret", owner: "you" },
          { text: "Write the migration", owner: "agent" },
          { text: "Approve the vendor account", owner: "you" },
        ],
      },
      { by: "user" },
    );
    expect(created.items.map((item) => item.ref)).toEqual(["T1", undefined, "T2"]);
    const [rotate, migrate, approve] = created.items;
    // Edits keep a task's number, a finished task keeps its number, and a new task takes the next.
    const edited = yield* h.service.update(
      {
        threadId,
        expectedRevision: created.revision,
        changes: [
          { id: rotate!.id, text: "Rotate the staging webhook secret today" },
          { id: approve!.id, state: "done" },
          { id: migrate!.id, owner: "you" },
        ],
      },
      { by: "user" },
    );
    expect(edited.items.map((item) => item.ref)).toEqual(["T1", "T3", "T2"]);
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Ship it?" }] });
    expect((yield* h.service.waitingItems(threadId)).items).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Ship it?", state: "open" },
      {
        kind: "task",
        ref: "T1",
        key: rotate!.id,
        title: "Rotate the staging webhook secret today",
        state: "open",
      },
      { kind: "task", ref: "T3", key: migrate!.id, title: "Write the migration", state: "open" },
    ]);
    expect(yield* h.service.waitingThreads).toEqual([threadId]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "closes a user task for the agent only from the user's message, and keeps it listed",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const agent = { by: "agent", threadId } as const;
      const created = yield* h.service.update(
        {
          threadId,
          expectedRevision: 0,
          changes: [
            { id: "rotate", text: "Rotate the staging webhook secret", owner: "you" },
            { id: "approve", text: "Approve the vendor account", owner: "you" },
          ],
        },
        agent,
      );
      const refused = (
        changes: ReadonlyArray<Parameters<typeof h.service.update>[0]["changes"][number]>,
        actor: Parameters<typeof h.service.update>[1] = agent,
      ) =>
        h.service.update({ threadId, expectedRevision: created.revision, changes }, actor).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      expect(yield* refused([{ id: "rotate", state: "done" }])).toBe(
        "Only the user marks their task done; record it from their message with settledFromUser.",
      );
      expect(yield* refused([{ id: "rotate", state: "done", settledFromUser: true }])).toBe(
        "Only the user's message in this turn can settle this.",
      );
      expect(yield* refused([{ id: "approve", state: "dropped" }])).toBe(
        "Dropping the user's task needs a note saying why.",
      );
      expect(
        yield* h.service
          .rewrite(
            {
              threadId,
              expectedRevision: created.revision,
              // Keeps T1 whole and leaves T2 out.
              items: [{ id: "rotate", text: "Rotate the staging webhook secret", owner: "you" }],
            },
            agent,
          )
          .pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          ),
      ).toContain("An open user task leaves the user's list only when closed");
      const message = MessageId.make("message-user");
      // The agent's own thread is in a turn the user's message started.
      h.turnMessage.current = message;
      const settled = yield* h.service.update(
        {
          threadId,
          expectedRevision: created.revision,
          changes: [
            // A task's ref names it as well as its id.
            { id: "T1", state: "done", settledFromUser: true, note: "done, rotated it" },
            { id: "approve", state: "dropped", note: "The vendor closed the account" },
          ],
        },
        { by: "agent", threadId },
      );
      expect(settled.items).toMatchObject([
        {
          id: "rotate",
          ref: "T1",
          state: "done",
          settledBy: "agent",
          settledFromMessageId: message,
        },
        { ref: "T2", state: "dropped", settledBy: "agent", note: "The vendor closed the account" },
      ]);
      // The relayed message is checked against the user messages since T1 was filed.
      expect(h.turnMessage.anchors).toEqual([created.items[0]!.createdAt]);
      expect(
        (yield* h.service.waitingItems(threadId)).items.filter((item) => item.kind === "task"),
      ).toEqual([]);
      expect((yield* h.service.waitingWork(threadId)).tasks.map((task) => task.ref)).toEqual([
        "T1",
        "T2",
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("names no message for a task outcome an agent relays after a later user message", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const agent = { by: "agent", threadId } as const;
    const filed = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [{ id: "rotate", text: "Rotate the staging webhook secret", owner: "you" }],
      },
      agent,
    );
    // The user said it was done, then asked for something else; the agent relays the outcome in
    // that later turn, so either message may have been its source.
    h.turnMessage.current = MessageId.make("message-unrelated");
    h.turnMessage.sole = false;
    const late = yield* h.service.update(
      {
        threadId,
        expectedRevision: filed.revision,
        changes: [{ id: "T1", state: "done", settledFromUser: true, note: "done, rotated it" }],
      },
      agent,
    );
    expect(late.items[0]).toMatchObject({
      state: "done",
      settledBy: "agent",
      note: "done, rotated it",
    });
    expect(late.items[0]).not.toHaveProperty("settledFromMessageId");
    expect(h.turnMessage.anchors).toEqual([filed.items[0]!.createdAt]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps the message a task outcome came from when the agent only clarifies its note", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const agent = { by: "agent", threadId } as const;
    const filed = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [{ id: "rotate", text: "Rotate the staging webhook secret", owner: "you" }],
      },
      agent,
    );
    h.turnMessage.current = MessageId.make("message-done");
    const settled = yield* h.service.update(
      {
        threadId,
        expectedRevision: filed.revision,
        changes: [{ id: "T1", state: "done", settledFromUser: true, note: "done, rotated it" }],
      },
      agent,
    );
    expect(settled.items[0]).toMatchObject({ settledFromMessageId: "message-done" });
    // An unrelated later turn, its message the one since the task was filed as far as the read
    // knows: a relay that keeps the outcome changes only the note.
    h.turnMessage.current = MessageId.make("message-ci");
    const clarified = yield* h.service.update(
      {
        threadId,
        expectedRevision: settled.revision,
        changes: [{ id: "T1", state: "done", settledFromUser: true, note: "rotated both keys" }],
      },
      agent,
    );
    expect(clarified.items[0]).toMatchObject({
      state: "done",
      settledBy: "agent",
      settledFromMessageId: "message-done",
      note: "rotated both keys",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps the message a question's answer came from when the agent records it again", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Which region?" }] });
    const record = (notes: string) =>
      h.service.questionUpdate(
        { threadId, id: "Q1", state: "answered", answer: { notes } },
        "agent",
      );
    h.turnMessage.current = MessageId.make("message-answer");
    expect((yield* record("eu-west")).questions[0]).toMatchObject({
      settledFromMessageId: "message-answer",
    });
    // A corrected note in an unrelated later turn is refused, and the answer keeps its message.
    h.turnMessage.current = MessageId.make("message-ci");
    expect((yield* failureOf(record("eu-west-1"))).code).toBe("invalid");
    expect((yield* h.service.get({ threadId })).questions[0]).toMatchObject({
      answer: { notes: "eu-west" },
      settledFromMessageId: "message-answer",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps the user's Done and dismissal note from an agent without the user's message", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const agent = { by: "agent", threadId } as const;
    const user = { by: "user" } as const;
    let workspace = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [{ id: "rotate", text: "Rotate the staging webhook secret", owner: "you" }],
      },
      agent,
    );
    const write = (
      changes: Parameters<typeof h.service.update>[0]["changes"],
      actor: Parameters<typeof h.service.update>[1],
    ) => h.service.update({ threadId, expectedRevision: workspace.revision, changes }, actor);
    workspace = yield* write([{ id: "rotate", state: "done" }], user);
    expect(
      (yield* write([{ id: "rotate", state: "dropped", note: "Agent cancelled it" }], agent).pipe(
        Effect.flip,
      )).message,
    ).toContain("The user recorded this task's outcome");
    workspace = yield* write([{ id: "rotate", state: "dropped", note: "My reason" }], user);
    expect(
      (yield* write([{ id: "rotate", state: "open" }], agent).pipe(Effect.flip)).message,
    ).toContain("The user recorded this task's outcome");
    expect((yield* h.service.get({ threadId })).items[0]).toMatchObject({
      state: "dropped",
      settledBy: "user",
      note: "My reason",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("shows a task discussed until the user changes it again", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const created = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [{ id: "rotate", text: "Rotate the staging webhook secret", owner: "you" }],
      },
      { by: "agent", threadId },
    );
    yield* h.service.markDiscussed({
      threadId,
      messageId: MessageId.make("message-discuss"),
      questionIds: [],
      taskIds: ["rotate", "missing"],
    });
    expect((yield* h.service.waitingItems(threadId)).items).toEqual([
      {
        kind: "task",
        ref: "T1",
        key: "rotate",
        title: "Rotate the staging webhook secret",
        state: "discussing",
      },
    ]);
    // Discussing writes no revision, so the user's next write still applies.
    const done = yield* h.service.update(
      { threadId, expectedRevision: created.revision, changes: [{ id: "rotate", state: "done" }] },
      { by: "user" },
    );
    expect(done.items[0]).toMatchObject({ state: "done", settledBy: "user" });
    expect(done.items[0]?.discussedInMessageId).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("never gives a dropped task's number to a new one", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const created = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [
          { text: "Rotate the staging webhook secret", owner: "you" },
          { text: "Approve the vendor account", owner: "you" },
        ],
      },
      { by: "user" },
    );
    expect(created.items.map((item) => item.ref)).toEqual(["T1", "T2"]);
    // A rewrite replaces every open item, so T2, the highest number, leaves the list.
    const rewritten = yield* h.service.rewrite(
      {
        threadId,
        expectedRevision: created.revision,
        items: [
          { id: created.items[0]!.id, text: "Rotate the staging webhook secret", owner: "you" },
        ],
      },
      { by: "user" },
    );
    expect(rewritten.items.map((item) => item.ref)).toEqual(["T1"]);
    const added = yield* h.service.update(
      {
        threadId,
        expectedRevision: rewritten.revision,
        changes: [{ text: "Renew the signing certificate", owner: "you" }],
      },
      { by: "user" },
    );
    expect(added.items.map((item) => item.ref)).toEqual(["T1", "T3"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reports from the write itself which items it changed and which tasks it filed", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const agent = { by: "agent", threadId } as const;
    const created = yield* h.writes.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [
          { id: "checklist", text: "Write the migration", owner: "agent" },
          { id: "rotate", text: "Rotate the staging webhook secret", owner: "you" },
        ],
      },
      agent,
    );
    expect([created.changedIds, created.filedTasks]).toEqual([["checklist", "rotate"], ["T1"]]);
    const handed = yield* h.writes.update(
      {
        threadId,
        expectedRevision: created.workspace.revision,
        changes: [
          { id: "checklist", owner: "you" },
          { id: "T1", text: "Rotate it today" },
        ],
      },
      agent,
    );
    // Handing an item over files it; editing a task already filed does not.
    expect([handed.changedIds, handed.filedTasks]).toEqual([["checklist", "rotate"], ["T2"]]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("files at most the card limit of user tasks in one write, with a clear refusal", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const tasks = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        text: `Task ${index + 1}`,
        owner: "you" as const,
      }));
    const agent = { by: "agent", threadId } as const;
    expect(
      (yield* h.service
        .update({ threadId, expectedRevision: 0, changes: tasks(101) }, agent)
        .pipe(Effect.flip)).message,
    ).toBe(
      "File at most 100 tasks for the user in one list write; split the rest into another call.",
    );
    const written = yield* h.writes.update(
      { threadId, expectedRevision: 0, changes: tasks(100) },
      agent,
    );
    expect(written.filedTasks).toHaveLength(100);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("names a task by its ref alone, and refuses an id that reads as another's ref", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const agent = { by: "agent", threadId } as const;
    const created = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [
          { id: "checklist", text: "Write the migration", owner: "agent" },
          { id: "rotate", text: "Rotate the staging webhook secret", owner: "you" },
        ],
      },
      agent,
    );
    const refusal = <A>(write: Effect.Effect<A, ThreadWorkspaceError>) =>
      write.pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
    // A new item never takes an id that reads as a task ref, so a ref names one row.
    expect(
      yield* refusal(
        h.service.update(
          {
            threadId,
            expectedRevision: created.revision,
            changes: [{ id: "T7", text: "Looks like a task", owner: "agent" }],
          },
          agent,
        ),
      ),
    ).toContain("T7 is not a task in this list");
    // A list saved before the rule can still hold such an id beside the task that has the ref.
    const file = h.path.join(
      h.config.stateDir,
      "thread-workspaces",
      `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
    );
    const stored = JSON.parse(yield* h.fs.readFileString(file));
    stored.workspace.items[0].id = "T1";
    yield* h.fs.writeFileString(file, JSON.stringify(stored));
    expect(
      yield* refusal(
        h.service.update(
          {
            threadId,
            expectedRevision: created.revision,
            changes: [{ id: "T1", text: "Rotate it today" }],
          },
          agent,
        ),
      ),
    ).toContain("T1 names a task and another item's id; use the task's id rotate.");
    // Before one resolver, this rewrite counted T1 as the kept task but wrote the literal row,
    // removing the open task.
    expect(
      yield* refusal(
        h.service.rewrite(
          {
            threadId,
            expectedRevision: created.revision,
            items: [{ id: "T1", text: "Write the migration", owner: "agent" }],
          },
          agent,
        ),
      ),
    ).toContain("T1 names a task and another item's id");
    expect((yield* h.service.get({ threadId })).items.map((item) => item.id)).toEqual([
      "T1",
      "rotate",
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("numbers tasks saved before task numbers existed when their thread is next read", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const created = yield* h.service.update(
      {
        threadId,
        expectedRevision: 0,
        changes: [{ text: "Rotate the secret", owner: "you" }],
      },
      { by: "user" },
    );
    const file = h.path.join(
      h.config.stateDir,
      "thread-workspaces",
      `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
    );
    const stored = JSON.parse(yield* h.fs.readFileString(file));
    delete stored.workspace.items[0].ref;
    delete stored.workspace.lastTaskRef;
    yield* h.fs.writeFileString(file, JSON.stringify(stored));
    expect((yield* h.service.waitingItems(threadId)).items).toEqual([
      {
        kind: "task",
        ref: "T1",
        key: created.items[0]!.id,
        title: "Rotate the secret",
        state: "open",
      },
    ]);
    expect(JSON.parse(yield* h.fs.readFileString(file)).workspace.items[0].ref).toBe("T1");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("migrates a legacy file once and persists mark annotations outside the list", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const directory = h.path.join(h.config.stateDir, "thread-workspaces");
    const name = `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`;
    const file = h.path.join(directory, name);
    yield* h.fs.makeDirectory(directory, { recursive: true });
    yield* h.fs.writeFileString(
      file,
      JSON.stringify({ formatVersion: 2, workspace: { ...fixture, threadId } }),
    );
    const original = yield* h.fs.readFileString(file);
    const first = yield* h.service.get({ threadId });
    expect(first.revision).toBe(fixture.revision);
    expect(first.questions).toEqual([]);
    expect(first.items.find((item) => item.id === "work-1")?.details).toContain(
      "Verified sample behavior",
    );
    const saved = yield* h.fs.readFileString(file);
    expect(JSON.parse(saved).formatVersion).toBe(3);
    expect(yield* h.fs.readFileString(`${file}.format2.bak`)).toBe(original);
    expect(JSON.parse(saved).workspace.markAnnotations).toBeUndefined();
    expect(
      JSON.parse(yield* h.fs.readFileString(h.path.join(h.config.stateDir, "thread-marks", name))),
    ).toEqual(fixture.markAnnotations);
    const reloadedContext = yield* Layer.build(
      Layer.fresh(Workspaces.layer).pipe(Layer.provide(h.dependencies)),
    );
    const reloaded = Context.get(reloadedContext, Workspaces.ThreadWorkspace);
    expect(yield* reloaded.get({ threadId })).toEqual(first);
    expect(yield* h.fs.readFileString(file)).toBe(saved);
    const dirty = JSON.parse(saved);
    const dirtyItem = dirty.workspace.items.find((item: { id: string }) => item.id === "work-1");
    dirtyItem.needsQa = true;
    dirtyItem.details = `Implementation details\n\nrecordedByThreadId: original-author-thread\n\n${JSON.stringify({ ...fixture.verifications[0], verifier: "Stale raw verifier" })}\n\nLater edit`;
    yield* h.fs.writeFileString(file, JSON.stringify(dirty));
    const cleaned = yield* reloaded.get({ threadId });
    const cleanDetails = cleaned.items.find((item) => item.id === "work-1")!.details;
    expect(cleanDetails).toContain("Verified by reviewer (executed) on abc123: partial");
    expect(cleanDetails).toContain("Later edit");
    expect(cleanDetails).not.toContain("recordedByThreadId");
    expect(cleanDetails).not.toContain('"workId"');
    expect(cleaned.items.find((item) => item.id === "work-1")).not.toHaveProperty("needsQa");
    expect(cleaned.revision).toBe(first.revision);
    const cleanedFile = yield* h.fs.readFileString(file);
    yield* reloaded.get({ threadId });
    expect(yield* h.fs.readFileString(file)).toBe(cleanedFile);
    expect(yield* h.fs.readFileString(`${file}.format2.bak`)).toBe(original);
    // Files written before thread questions existed open without them, and the next write adds them.
    const { questions: _questions, ...withoutQuestions } = JSON.parse(cleanedFile).workspace;
    yield* h.fs.writeFileString(
      file,
      JSON.stringify({ formatVersion: 3, workspace: withoutQuestions }),
    );
    expect((yield* reloaded.get({ threadId })).questions).toEqual([]);
    const asked = yield* reloaded.questionAsk({ threadId, questions: [{ prompt: "Ship it?" }] });
    expect(asked.questions.map((question) => question.id)).toEqual(["Q1"]);
    expect(JSON.parse(yield* h.fs.readFileString(file)).workspace.questions).toHaveLength(1);
    yield* h.fs.writeFileString(file, original);
    yield* h.fs.writeFileString(`${file}.format2.bak`, "Preexisting backup bytes");
    yield* reloaded.get({ threadId });
    expect(yield* h.fs.readFileString(`${file}.format2.bak`)).toBe("Preexisting backup bytes");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
