// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { expect, it } from "@effect/vitest";
import {
  RunId,
  MessageId,
  ComposerContextId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ServerCommand,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type OrchestrationV2ThreadQuestionSummary,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
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
const harness = Effect.fn("test.workspaceHarness")(function* () {
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
  const syncs: Array<ReadonlyArray<OrchestrationV2ThreadQuestionSummary>> = [];
  const mirror = { questions: [] as ReadonlyArray<OrchestrationV2ThreadQuestionSummary> };
  const dispatchFailures = { remaining: 0 };
  const threadState = { archivedAt: null as DateTime.Utc | null };
  // Like the orchestrator's command receipts: a repeated command id delivers nothing new.
  const delivered: ThreadManagement.ThreadManagementSendInput[] = [];
  const hooks = { onSend: (): void => undefined };
  const messages: OrchestrationV2ConversationMessage[] = [];
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
      getThreadRecords: (id) =>
        Effect.sync(() => ({
          ...projection,
          messages,
          thread: {
            ...projection.thread,
            id,
            questions: mirror.questions,
            archivedAt: threadState.archivedAt,
          },
          runs: id === threadId ? [] : [run()],
        })),
      dispatch: (command: OrchestrationV2ServerCommand) => {
        if (dispatchFailures.remaining > 0) {
          dispatchFailures.remaining--;
          return Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "unavailable",
            }),
          );
        }
        if (command.type === "thread.questions.sync") {
          syncs.push(command.questions);
          mirror.questions = command.questions;
        }
        return Effect.succeed({ sequence: 1, storedEvents: [] });
      },
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
  return {
    service: Context.get(context, Workspaces.ThreadWorkspace),
    sends,
    delivered,
    hooks,
    threadState,
    syncs,
    mirror,
    dispatchFailures,
    messages,
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
    expect((yield* h.service.update(input).pipe(Effect.result))._tag).toBe("Failure");
    yield* h.service.update({ ...input, changes: [{ ...input.changes[0]!, state: "handed_off" }] });
    expect((yield* h.service.get({ threadId })).items[0]?.linkStates?.[0]?.state).toBe("open");
    h.closeTicket();
    expect((yield* h.service.get({ threadId })).items[0]).toMatchObject({
      state: "handed_off",
      linkStates: [{ state: "closed", title: "Sample ticket" }],
    });
    const done = yield* h.service.update({
      threadId,
      expectedRevision: 1,
      changes: [{ id: "ticket", state: "done" }],
    });
    expect(done.items[0]?.doneAt).not.toBeNull();
    h.reopenTicket();
    const reopened = yield* h.service.update({
      threadId,
      expectedRevision: done.revision,
      changes: [{ id: "ticket", state: "handed_off" }],
    });
    expect(
      (yield* h.service
        .update({
          threadId,
          expectedRevision: reopened.revision,
          changes: [{ id: "ticket", state: "done" }],
        })
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
        .update({ threadId, expectedRevision: 0, changes: [change] })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* h.service.update({
      threadId,
      expectedRevision: 0,
      changes: [{ ...change, state: "handed_off" }],
    });
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
    yield* h.service.update({
      threadId,
      expectedRevision: 0,
      changes: [
        { id: "open", text: "Old open" },
        { id: "done", text: "Finished", state: "done" },
        { id: "dropped", text: "Dropped", state: "dropped" },
        { id: "handoff", text: "Delegated", state: "handed_off" },
      ],
    });
    const next = yield* h.service.rewrite({
      threadId,
      expectedRevision: 1,
      items: [{ id: "new", text: "Replacement" }],
    });
    expect(next.items.map((item) => item.id)).toEqual(["done", "dropped", "handoff", "new"]);
    expect(
      (yield* h.service
        .rewrite({
          threadId,
          expectedRevision: 2,
          items: [{ id: "done", text: "Overwrite history" }],
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* h.service
        .update({ threadId, expectedRevision: 2, changes: [], order: ["new", "done"] })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const ordered = yield* h.service.update({
      threadId,
      expectedRevision: 2,
      changes: [],
      order: ["new", "handoff", "dropped", "done"],
    });
    expect(ordered.items.map((item) => item.id)).toEqual(["new", "handoff", "dropped", "done"]);
    expect((yield* h.service.listRead({ threadId }))[0]?.items.map((item) => item.id)).toEqual([
      "new",
      "handoff",
    ]);
    const tree = yield* h.service.update({
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
    });
    const rewritten = yield* h.service.rewrite({
      threadId,
      expectedRevision: tree.revision,
      items: [],
    });
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
    yield* h.service.update({
      threadId,
      expectedRevision: 2,
      changes: [
        { id: "parent", text: "Parent", links: [{ type: "artifact", target: "design" }] },
        { id: "child", text: "Child", parentId: "parent" },
      ],
    });
    const nested = yield* h.service.update({
      threadId,
      expectedRevision: 3,
      changes: [
        { id: "grandchild", text: "Grandchild", parentId: "child" },
        { id: "other", text: "Other root" },
      ],
    });
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
          .update({ threadId, expectedRevision: nested.revision, changes: [change] })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    const moved = yield* h.service.update({
      threadId,
      expectedRevision: nested.revision,
      changes: [{ id: "child", parentId: "other" }],
    });
    expect(moved.items.find((item) => item.id === "grandchild")?.parentId).toBe("child");
    const completed = yield* h.service.update({
      threadId,
      expectedRevision: moved.revision,
      changes: [{ id: "other", state: "done" }],
    });
    const dropped = yield* h.service.update({
      threadId,
      expectedRevision: completed.revision,
      changes: [{ id: "other", state: "dropped" }],
    });
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
    expect(h.mirror.questions).toEqual([
      { id: "Q1", title: "Which database should the cache use for local…", state: "open" },
      { id: "Q2", title: "Ship behind a flag?", state: "open" },
    ]);
    yield* update("Q1", "deferred", "user");
    expect(h.mirror.questions.map((question) => question.state)).toEqual(["deferred", "open"]);
    expect(h.mirror.questions[0]?.userChangedAt).toBeDefined();
    yield* update("Q1", "open", "agent");
    expect(h.mirror.questions[0]).not.toHaveProperty("userChangedAt");
    const answered = yield* update("Q2", "answered", "agent", { notes: "Yes, default off" });
    expect(answered.questions[1]).toMatchObject({
      state: "answered",
      answeredBy: "agent",
      answer: { chosenOptionIds: [], notes: "Yes, default off" },
    });
    expect(answered.questions[1]?.closedAt).not.toBeNull();
    yield* update("Q1", "withdrawn", "user");
    // Kept so the agent's next user-message turn hears the user dismissed it.
    expect(h.mirror.questions).toEqual([
      {
        id: "Q1",
        title: expect.any(String),
        state: "withdrawn",
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
    expect(h.mirror.questions.map((question) => question.id)).toEqual(["Q1", "Q2", "Q4"]);

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

it.effect("submits drafted answers to the thread as one user message", () =>
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
    expect(
      (yield* failureOf(
        h.service.questionDraft({
          threadId,
          answers: { Q1: { chosenOptionIds: ["mysql"], notes: "" } },
        }),
      )).code,
    ).toBe("invalid");
    yield* h.service.questionDraft({
      threadId,
      answers: {
        Q1: { chosenOptionIds: ["pg"], notes: "" },
        Q2: { chosenOptionIds: [], notes: "cache-v2" },
      },
    });
    expect(h.sends).toHaveLength(0);
    expect((yield* failureOf(h.service.questionSubmit({ threadId, ids: ["Q1", "Q3"] }))).code).toBe(
      "invalid",
    );
    expect(h.sends).toHaveLength(0);
    const submitted = yield* h.service.questionSubmit({ threadId, ids: ["Q1", "Q2"] });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({ origin: { kind: "user" }, createdBy: "user" });
    expect(h.sends[0]?.context?.records).toEqual([
      expect.objectContaining({
        kind: "artifact-answer",
        artifactId: THREAD_QUESTIONS_ARTIFACT_ID,
        questionId: "Q1",
        question: "Database?",
        choice: "Postgres",
      }),
      expect.objectContaining({ questionId: "Q2", choice: "", note: "cache-v2" }),
    ]);
    expect(submitted.questions.map((question) => [question.state, question.answeredBy])).toEqual([
      ["answered", "user"],
      ["answered", "user"],
      ["open", null],
    ]);
    expect(h.mirror.questions.map((question) => question.id)).toEqual(["Q3"]);
    expect((yield* failureOf(h.service.questionSubmit({ threadId, ids: ["Q1"] }))).code).toBe(
      "invalid",
    );
    expect(
      (yield* failureOf(
        h.service.questionDraft({ threadId, answers: { Q1: { chosenOptionIds: [], notes: "x" } } }),
      )).code,
    ).toBe("invalid");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("repairs a mirror a failed sync left stale, on the next read or at startup", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.dispatchFailures.remaining = 1;
    yield* h.service.questionAsk({ threadId, questions: [{ prompt: "Ship it?" }] });
    expect(h.mirror.questions).toEqual([]);
    yield* h.service.get({ threadId });
    expect(h.mirror.questions).toEqual([{ id: "Q1", title: "Ship it?", state: "open" }]);
    yield* h.service.get({ threadId });
    expect(h.syncs).toHaveLength(1);

    // No read follows the failed sync: the next server start reconciles from the file.
    // Archived threads are reconciled too, so unarchiving shows the right count.
    h.threadState.archivedAt = at;
    h.dispatchFailures.remaining = 1;
    yield* h.service.questionUpdate({ threadId, id: "Q1", state: "deferred" }, "user");
    expect(h.mirror.questions).toEqual([{ id: "Q1", title: "Ship it?", state: "open" }]);
    const restarted = Context.get(
      yield* Layer.build(Layer.fresh(Workspaces.layer).pipe(Layer.provide(h.dependencies))),
      Workspaces.ThreadWorkspace,
    );
    yield* h.fs.writeFileString(
      h.path.join(h.config.stateDir, "thread-workspaces", `${"a".repeat(64)}.json`),
      "not a workspace",
    );
    expect(yield* restarted.reconcileQuestions).toBe(1);
    expect(h.mirror.questions).toEqual([
      { id: "Q1", title: "Ship it?", state: "deferred", userChangedAt: expect.any(String) },
    ]);
    expect(yield* restarted.reconcileQuestions).toBe(1);
    expect(h.syncs).toHaveLength(2);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("finishes a submit whose save failed after the send without sending again", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.questionAsk({
      threadId,
      questions: [
        { prompt: "Database?", options: [choice("pg", "Postgres"), choice("lite", "SQLite")] },
        { prompt: "Flag name?" },
      ],
    });
    yield* h.service.questionDraft({
      threadId,
      answers: {
        Q1: { chosenOptionIds: ["pg"], notes: "" },
        Q2: { chosenOptionIds: [], notes: "cache-v2" },
      },
    });
    const directory = h.path.join(h.config.stateDir, "thread-workspaces");
    h.hooks.onSend = () => NodeFS.chmodSync(directory, 0o500);
    const failed = yield* failureOf(h.service.questionSubmit({ threadId, ids: ["Q1", "Q2"] }));
    NodeFS.chmodSync(directory, 0o700);
    h.hooks.onSend = () => undefined;
    expect(failed.code).toBe("storage");
    expect(
      (yield* h.service.get({ threadId })).questions.map((question) => question.state),
    ).toEqual(["open", "open"]);
    const before = yield* h.service.get({ threadId });
    yield* h.service.update({
      threadId,
      expectedRevision: before.revision,
      changes: [{ text: "Unrelated task" }],
    });
    const retried = yield* h.service.questionSubmit({ threadId, ids: ["Q2", "Q1"] });
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]?.commandId).toBe(h.sends[0]?.commandId);
    expect(h.delivered).toHaveLength(1);
    expect(retried.questions.map((question) => [question.state, question.answeredBy])).toEqual([
      ["answered", "user"],
      ["answered", "user"],
    ]);

    yield* h.service.questionUpdate({ threadId, id: "Q2", state: "open" }, "user");
    yield* h.service.questionSubmit({ threadId, ids: ["Q2"] });
    expect(h.delivered).toHaveLength(2);
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
