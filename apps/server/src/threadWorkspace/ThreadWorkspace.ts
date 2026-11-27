// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  ThreadWorkspace as Workspace,
  ThreadWorkspaceError,
  ThreadId,
  CommandId,
  MessageId,
  ComposerContextId,
  parseArtifactQuestions,
  artifactAnswerFits,
  artifactQuestionIsConsistent,
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  threadQuestionTitle,
  questionWaitingItems,
  taskWaitingItems,
  TrackedAnswerText,
  TrackedAnswerMore,
  TrackedAsk,
  type RunId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadStreamItem,
  type TrackedAnswer,
  type TrackedAnswerWaitingRow,
  type TrackedAnswersPage,
  type TrackedAnswersReadInput,
  type ThreadTrackMessageInput,
  type ThreadUpdateAskInput,
  type ArtifactAnswerContextRecord,
  type WaitingItemSummary,
  type ThreadQuestion,
  type ThreadQuestionAskInput,
  type ThreadQuestionDraftInput,
  type ThreadQuestionUpdateInput,
  type ThreadArtifactAnswerInput,
  type ThreadArtifactSubmitInput,
  listItemNeedsHandoff,
  type ListItem,
  LIST_FILED_TASKS_LIMIT,
  LIST_MAX_DEPTH,
  type ThreadWorkspaceGetInput,
  type ThreadListUpdateInput,
  type ThreadListRewriteInput,
  type ThreadListReadInput,
  type ThreadListEntry,
  type ThreadArtifactWriteInput,
  type ThreadArtifactReadInput,
  type ThreadArtifactVersion,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  changeUserTask,
  removedOpenTasks,
  resolveListItemId,
  TASK_LEAVES_ONLY_CLOSED,
  type ListActor,
} from "./userTasks.ts";
import * as TicketTracker from "../ticketTracker/TicketTracker.ts";
import { LegacyWorkspace, migrateWorkspace, cleanMigratedDetails } from "./workspaceMigration.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  formatComposerContextHref,
  sanitizeComposerContextLabel,
  trackedAskContextForMessage,
} from "@t3tools/shared/composerContextReferences";
import { migrateAnnotations } from "./ThreadMarks.ts";
import {
  questionDeliveries,
  questionDiscussions,
  runsWithProviderTurn,
  type QuestionDiscussion,
} from "./questionDelivery.ts";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  addTrackedAsk,
  appendTrackedAnswer,
  invalidAsk,
  missingAsk,
  rollBackTrackedAsk,
  updateTrackedAsk,
} from "./trackedAsks.ts";

export class ThreadWorkspace extends Context.Service<
  ThreadWorkspace,
  {
    readonly get: (
      input: ThreadWorkspaceGetInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly trackMessage: (
      input: ThreadTrackMessageInput,
    ) => Effect.Effect<TrackedAsk, ThreadWorkspaceError>;
    readonly updateAsk: (
      input: ThreadUpdateAskInput,
    ) => Effect.Effect<TrackedAsk, ThreadWorkspaceError>;
    readonly asksRead: (
      input: TrackedAnswersReadInput,
    ) => Effect.Effect<TrackedAnswersPage, ThreadWorkspaceError>;
    readonly answerAsk: (input: {
      readonly threadId: ThreadId;
      readonly id: string;
      readonly text: string;
      readonly more?: string;
      readonly runId?: RunId | null;
    }) => Effect.Effect<TrackedAnswer, ThreadWorkspaceError>;
    readonly recordTrackedMessages: (
      threadId: ThreadId,
      messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
      delivered: boolean,
      editing?: boolean,
    ) => Effect.Effect<ReadonlyArray<TrackedAsk>, ThreadWorkspaceError>;
    readonly listRead: (
      input: ThreadListReadInput,
    ) => Effect.Effect<ReadonlyArray<ThreadListEntry>, ThreadWorkspaceError>;
    /**
     * The agent closes a user task only from the user's message in its own thread's turn, which
     * the service reads itself; see `userTasks.ts`. Returns what the write changed and filed.
     */
    readonly update: (
      input: ThreadListUpdateInput,
      caller: ListCaller,
    ) => Effect.Effect<ListWrite, ThreadWorkspaceError>;
    readonly rewrite: (
      input: ThreadListRewriteInput,
      caller: ListCaller,
    ) => Effect.Effect<ListWrite, ThreadWorkspaceError>;
    readonly artifactWrite: (
      input: ThreadArtifactWriteInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly artifactAnswer: (
      input: ThreadArtifactAnswerInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly artifactSubmit: (
      input: ThreadArtifactSubmitInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly artifactRead: (
      input: ThreadArtifactReadInput,
    ) => Effect.Effect<ThreadArtifactVersion, ThreadWorkspaceError>;
    /** Adds questions without blocking the asking turn; ids continue Q1, Q2, ... per thread. */
    readonly questionAsk: (
      input: ThreadQuestionAskInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    /** Only the agent records an answer here; the user's answers ride their own messages. */
    readonly questionUpdate: (
      input: ThreadQuestionUpdateInput,
      by: "user" | "agent",
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly questionDraft: (
      input: ThreadQuestionDraftInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    /**
     * Marks the waiting questions and open user tasks a user's message took into chat through
     * their cards' Discuss, so they show as discussing until the user changes them again.
     */
    readonly markDiscussed: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly questionIds: ReadonlyArray<string>;
      readonly taskIds: ReadonlyArray<string>;
    }) => Effect.Effect<void, ThreadWorkspaceError>;
    /**
     * The thread's questions and user tasks as waiting items: every waiting one, plus questions
     * the user withdrew. Repairs answer delivery first and numbers tasks that have no ref yet.
     */
    readonly waitingItems: (threadId: ThreadId) => Effect.Effect<
      {
        readonly items: ReadonlyArray<WaitingItemSummary>;
        readonly answers?: ReadonlyArray<TrackedAnswerWaitingRow>;
        readonly answersRevision?: number;
      },
      ThreadWorkspaceError
    >;
    readonly withTrackedAnswers: <E, R>(
      threadId: ThreadId,
      stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
    ) => Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>;
    /** The thread's questions and user tasks, for the lines ahead of an agent's turn. */
    readonly waitingWork: (threadId: ThreadId) => Effect.Effect<
      {
        readonly questions: ReadonlyArray<ThreadQuestion>;
        readonly tasks: ReadonlyArray<ListItem>;
        readonly asks?: ReadonlyArray<TrackedAsk>;
      },
      ThreadWorkspaceError
    >;
    /** Threads whose workspace file holds questions or tasks for the user, archived included. */
    readonly waitingThreads: Effect.Effect<ReadonlyArray<ThreadId>, ThreadWorkspaceError>;
    /** Each thread whose workspace file was written, as it is written. */
    readonly changes: Stream.Stream<ThreadId>;
    /**
     * Follows user messages and runs, so a question whose answer a message carries leaves the
     * count when the message is accepted, returns if the message is cancelled or edited, and
     * closes once its turn starts. Runs until interrupted.
     */
    readonly followQuestionDeliveries: Effect.Effect<void>;
    readonly artifactList: (input: ThreadWorkspaceGetInput) => Effect.Effect<
      ReadonlyArray<{
        id: string;
        title: string;
        format: "markdown" | "html";
        version: number;
        createdAt: string;
        unansweredQuestions: number;
      }>,
      ThreadWorkspaceError
    >;
  }
>()("t3/threadWorkspace/ThreadWorkspace") {}

/** Who writes the list: the user, or an agent calling from the thread whose turn it is. */
export type ListCaller =
  | { readonly by: "user" }
  | { readonly by: "agent"; readonly threadId: ThreadId | undefined };

/** The task rules' actor, with the agent's own thread for reading its turn's messages. */
type WriteActor =
  | Extract<ListActor, { readonly by: "user" }>
  | (Extract<ListActor, { readonly by: "agent" }> & { readonly threadId: ThreadId | undefined });

const withoutRelaySource = ({ settledFromMessageId: _, ...task }: ListItem): ListItem => task;

/** A list write's result: the saved list, the items it wrote and the user tasks it filed. */
export interface ListWrite {
  readonly workspace: Workspace;
  readonly changedIds: ReadonlyArray<string>;
  /** Refs of the items this write made the user's tasks, by creating them or handing them over. */
  readonly filedTasks: ReadonlyArray<string>;
}

export const emptyWorkspace = (threadId: ThreadId): Workspace => ({
  threadId,
  revision: 0,
  items: [],
  artifacts: [],
  questions: [],
  summaryNotes: "",
  childPreamble: "",
  updatedAt: null,
});
const invalid = (message: string) => new ThreadWorkspaceError({ code: "invalid", message });
const isTrackedAnswerText = Schema.is(TrackedAnswerText);
const isTrackedAnswerMore = Schema.is(TrackedAnswerMore);
const isWorkspaceError = Schema.is(ThreadWorkspaceError);
const TOO_MANY_FILED = `File at most ${LIST_FILED_TASKS_LIMIT} tasks for the user in one list write; split the rest into another call.`;
/** How many items a write makes the user's tasks, by creating them or handing them over. */
const filedCount = (
  before: Workspace,
  items: ReadonlyArray<ListItem>,
  changedIds: ReadonlySet<string>,
) =>
  items.filter(
    (item) =>
      changedIds.has(item.id) &&
      item.owner === "you" &&
      before.items.find((entry) => entry.id === item.id)?.owner !== "you",
  ).length;
/** What a write changed, and the items it made the user's tasks, from the saved list. */
const listWrite = (
  before: Workspace,
  workspace: Workspace,
  changedIds: ReadonlySet<string>,
): ListWrite => ({
  workspace,
  changedIds: [...changedIds],
  filedTasks: workspace.items.flatMap((item) =>
    changedIds.has(item.id) &&
    item.owner === "you" &&
    item.ref !== undefined &&
    before.items.find((entry) => entry.id === item.id)?.owner !== "you"
      ? [item.ref]
      : [],
  ),
});
const missingQuestion = (id: string) =>
  new ThreadWorkspaceError({ code: "not_found", message: `${id} does not exist in this thread.` });

/** The first words of a question, for the thread list and an agent's turn context. */
const isWaiting = (
  question: ThreadQuestion,
): question is ThreadQuestion & { readonly state: "open" | "deferred" } =>
  question.state === "open" || question.state === "deferred";
const isUserTask = (item: ListItem) => item.owner === "you";
/**
 * Numbers the user's tasks T1, T2, ... in list order after the highest number ever given out,
 * and records that number; the same workspace when nothing changes.
 */
const withTaskRefs = <W extends Pick<Workspace, "items" | "lastTaskRef">>(workspace: W): W => {
  const highest = Math.max(
    workspace.lastTaskRef ?? 0,
    ...workspace.items.map((item) => Number(/^T(\d+)$/.exec(item.ref ?? "")?.[1] ?? 0)),
  );
  const unnumbered = workspace.items.some((item) => isUserTask(item) && item.ref === undefined);
  if (!unnumbered && highest === (workspace.lastTaskRef ?? 0)) return workspace;
  let next = highest;
  const items = workspace.items.map((item) =>
    isUserTask(item) && item.ref === undefined ? { ...item, ref: `T${++next}` } : item,
  );
  return { ...workspace, items, lastTaskRef: next };
};
const storage = (cause: unknown) =>
  new ThreadWorkspaceError({
    code: "storage",
    message: "Could not read or save the thread list.",
    cause,
  });
const Envelope = Schema.Struct({ formatVersion: Schema.Literal(3), workspace: Workspace });
const decode = Schema.decodeEffect(Schema.fromJsonString(Envelope));
const decodeStoredAsks = Schema.decodeUnknownEffect(Schema.Array(TrackedAsk));
const encode = Schema.encodeEffect(Schema.fromJsonString(Envelope));
const OldEnvelope = Schema.Struct({
  formatVersion: Schema.Literals([1, 2]),
  workspace: LegacyWorkspace,
});

const decodeOld = Schema.decodeEffect(Schema.fromJsonString(OldEnvelope));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const tracker = yield* TicketTracker.TicketTracker;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
  >();
  const lock = yield* Semaphore.make(1);
  const written = yield* PubSub.unbounded<ThreadId>();
  const directory = path.join(config.stateDir, "thread-workspaces");
  const filePath = (id: string) =>
    path.join(directory, `${NodeCrypto.createHash("sha256").update(id).digest("hex")}.json`);
  const requireThread = Effect.fn("ThreadWorkspace.requireThread")(function* (threadId: ThreadId) {
    const records = yield* orchestrator
      .getThreadRecords(threadId, [])
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadWorkspaceError({ code: "not_found", message: "Thread unavailable.", cause }),
        ),
      );
    if (records.thread.deletedAt !== null)
      return yield* new ThreadWorkspaceError({ code: "not_found", message: "Thread was deleted." });
    return records.thread;
  });
  const write = Effect.fn("ThreadWorkspace.write")(function* (workspace: Workspace) {
    const contents = yield* encode({ formatVersion: 3, workspace });
    yield* writeFileStringAtomically({ filePath: filePath(workspace.threadId), contents }).pipe(
      Effect.provide(services),
    );
    yield* PubSub.publish(written, workspace.threadId);
    return workspace;
  }, Effect.mapError(storage));
  const submittedAnswers = Effect.fn("ThreadWorkspace.submittedAnswers")(function* (
    workspace: Workspace,
  ) {
    if (
      !workspace.artifacts.some((a) =>
        a.versions.some((v) =>
          Object.values(v.answers).some((answer) => answer.submittedAt === null),
        ),
      )
    )
      return workspace;
    const records = yield* orchestrator
      .getThreadRecords(workspace.threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.mapError(storage));
    return {
      ...workspace,
      artifacts: workspace.artifacts.map((artifact) => ({
        ...artifact,
        versions: artifact.versions.map((version) => ({
          ...version,
          answers: Object.fromEntries(
            Object.entries(version.answers).map(([id, answer]) => {
              const question = version.questions.find((q) => q.id === id);
              if (answer.submittedAt || !question) return [id, answer];
              const choice = question.options
                .filter((o) => answer.chosenOptionIds.includes(o.id))
                .map((o) => o.label)
                .join(", ");
              const message = records.messages.findLast(
                (m) =>
                  m.role === "user" &&
                  !m.streaming &&
                  m.origin?.kind === "user" &&
                  m.context?.records.some(
                    (r) =>
                      r.kind === "artifact-answer" &&
                      "artifactId" in r &&
                      r.artifactId === artifact.id &&
                      r.artifactVersion === version.version &&
                      r.questionId === id &&
                      r.answerRevision === (answer.draftRevision ?? 0) &&
                      r.question === question.prompt &&
                      r.choice === choice &&
                      r.note === answer.notes,
                  ),
              );
              return [
                id,
                message
                  ? { ...answer, submittedAt: DateTime.formatIso(message.createdAt) }
                  : answer,
              ];
            }),
          ),
        })),
      })),
    };
  });
  // A sent comment takes the note it carried once its turn starts; a chosen option stays a draft.
  // An answer carrying the same draft wins: its note is what the agent was sent.
  const discussedAs = (
    question: ThreadQuestion,
    discussion: QuestionDiscussion | undefined,
    answerSent: boolean,
  ): ThreadQuestion => {
    const { discussedInMessageId: previous, ...rest } = question;
    if (discussion === undefined) return previous === undefined ? question : rest;
    const clearNote = discussion.clearNote && !answerSent && question.answer !== null;
    if (previous === discussion.messageId && !clearNote) return question;
    return {
      ...rest,
      discussedInMessageId: discussion.messageId,
      answer: clearNote && question.answer ? { ...question.answer, notes: "" } : question.answer,
    };
  };
  // Answers ride ordinary user messages, so where each one went is read from the thread itself.
  // Written without a new revision: nothing the user or agent wrote changed.
  // A draft save reads too, so only a full read looks for messages carrying unsent drafts.
  const deliverAnswers = Effect.fn("ThreadWorkspace.deliverAnswers")(function* (
    workspace: Workspace,
    scan: "drafts" | "sent",
  ) {
    if (
      !workspace.questions.some(
        (question) =>
          isWaiting(question) &&
          (question.sentInMessageId !== undefined ||
            question.discussedInMessageId !== undefined ||
            (scan === "drafts" &&
              question.answer !== null &&
              (question.answer.chosenOptionIds.length > 0 || question.answer.notes.trim()))),
      )
    )
      return workspace;
    const records = yield* orchestrator
      .getThreadRecords(workspace.threadId, ["messages", "runs", "attempts", "providerTurns"], {
        messageRoles: ["user"],
      })
      .pipe(Effect.mapError(storage));
    const accepted = runsWithProviderTurn(records.attempts, records.providerTurns);
    const deliveries = questionDeliveries(
      workspace.questions,
      records.messages,
      records.runs,
      accepted,
    );
    const discussions = questionDiscussions(
      workspace.questions,
      records.messages,
      records.runs,
      accepted,
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    let changed = false;
    const questions = workspace.questions.map((waiting): ThreadQuestion => {
      if (!isWaiting(waiting)) return waiting;
      const question = discussedAs(
        waiting,
        discussions.get(waiting.id),
        deliveries.has(waiting.id),
      );
      if (question !== waiting) changed = true;
      const delivery = deliveries.get(question.id);
      if (delivery?.received && question.answer) {
        changed = true;
        const { discussedInMessageId: _ended, ...answered } = question;
        return {
          ...answered,
          state: "answered",
          closedAt: now,
          answeredBy: "user",
          answer: { ...question.answer, submittedAt: now },
          sentInMessageId: delivery.messageId,
        };
      }
      if (delivery?.messageId === question.sentInMessageId) return question;
      changed = true;
      const { sentInMessageId: _unsent, ...rest } = question;
      return delivery ? { ...rest, sentInMessageId: delivery.messageId } : rest;
    });
    return changed ? yield* write({ ...workspace, questions }) : workspace;
  });
  const read = Effect.fn("ThreadWorkspace.read")(function* (
    threadId: ThreadId,
    scan: "drafts" | "sent" = "sent",
  ) {
    yield* requireThread(threadId);
    return yield* deliverAnswers(yield* load(threadId), scan);
  });
  const load = Effect.fn("ThreadWorkspace.load")(function* (threadId: ThreadId) {
    const contents = yield* fs.readFileString(filePath(threadId)).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(storage),
    );
    if (contents === null) return emptyWorkspace(threadId);
    const current = yield* decode(contents).pipe(Effect.result);
    if (current._tag === "Success") {
      if (current.success.workspace.threadId !== threadId)
        return yield* storage("Thread identity mismatch.");
      let workspace = current.success.workspace;
      if (workspace.items.some((item) => /recordedByThreadId|"workId"/.test(item.details))) {
        const backup = yield* fs.readFileString(`${filePath(threadId)}.format2.bak`).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(null),
          ),
          Effect.mapError(storage),
        );
        const original = backup === null ? null : yield* decodeOld(backup).pipe(Effect.result);
        const items = workspace.items.map((item) => ({
          ...item,
          details: cleanMigratedDetails(
            item.details,
            original?._tag === "Success" ? original.success.workspace : undefined,
          ),
        }));
        if (items.some((item, index) => item.details !== workspace.items[index]!.details))
          workspace = yield* write({ ...workspace, items });
      }
      return yield* submittedAnswers(workspace);
    }
    const old = yield* decodeOld(contents).pipe(Effect.mapError(storage));
    if (old.workspace.threadId !== threadId) return yield* storage("Thread identity mismatch.");
    yield* fs
      .writeFileString(`${filePath(threadId)}.format2.bak`, contents, { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
        Effect.mapError(storage),
      );
    const workspace = migrateWorkspace(old.workspace, DateTime.formatIso(yield* DateTime.now));
    yield* migrateAnnotations(threadId, contents).pipe(
      Effect.provide(services),
      Effect.mapError(storage),
    );
    return yield* submittedAnswers(yield* write(workspace));
  });
  const enrich = Effect.fn("ThreadWorkspace.enrich")(function* (workspace: Workspace) {
    const items = yield* Effect.forEach(workspace.items, (item) =>
      Effect.gen(function* () {
        const linkStates = yield* Effect.forEach(item.links, (link) =>
          Effect.gen(function* () {
            if (link.type === "ticket") {
              const ticket = yield* tracker.get(link.target);
              return {
                ...link,
                state:
                  ticket === null
                    ? ("unknown" as const)
                    : ticket.terminal === true
                      ? ("closed" as const)
                      : ("open" as const),
                label: ticket?.stage ?? "Unavailable",
                ...(ticket ? { url: ticket.url, title: ticket.title } : {}),
              };
            }
            if (link.type === "thread") {
              const lane = yield* orchestrator
                .getThreadRecords(ThreadId.make(link.target), ["runs"])
                .pipe(Effect.orElseSucceed(() => null));
              const run = lane?.runs.at(-1);
              return {
                ...link,
                state:
                  lane === null || !run
                    ? ("unknown" as const)
                    : ["completed", "failed", "interrupted", "cancelled"].includes(run.status)
                      ? ("needs_review" as const)
                      : ("open" as const),
                label: run?.status ?? "Unavailable",
                ...(lane ? { title: lane.thread.title } : {}),
              };
            }
            return { ...link, state: "unknown" as const, label: link.target };
          }),
        );
        return { ...item, linkStates };
      }),
    );
    return { ...workspace, items };
  });
  const commit = Effect.fn("ThreadWorkspace.commit")(function* (
    current: Workspace,
    next: Workspace,
    expectedRevision: number,
  ) {
    if (current.revision !== expectedRevision)
      return yield* new ThreadWorkspaceError({
        code: "conflict",
        message: "List changed. Read it again before writing.",
        currentRevision: current.revision,
      });
    if (new Set(next.items.map((item) => item.id)).size !== next.items.length)
      return yield* invalid("Item IDs must be unique.");
    for (const item of next.items) {
      if (!item.text.trim() || /[\r\n]/.test(item.text))
        return yield* invalid("Item text must be one nonempty line.");
      const ancestors = new Set([item.id]);
      let parentId = item.parentId;
      while (parentId !== null) {
        if (ancestors.has(parentId)) return yield* invalid("List items cannot form a cycle.");
        ancestors.add(parentId);
        if (ancestors.size > LIST_MAX_DEPTH)
          return yield* invalid("List items support only root, child, and grandchild levels.");
        const parent = next.items.find((entry) => entry.id === parentId);
        if (!parent) return yield* invalid("Parent item does not exist.");
        parentId = parent.parentId;
      }
      if (
        item.links.some(
          (link) =>
            link.type === "artifact" &&
            !next.artifacts.some((artifact) => artifact.id === link.target),
        )
      )
        return yield* invalid("Artifact link does not exist in this thread.");
    }
    const ticketsToCheck = [
      ...new Set(
        next.items
          .filter(
            (item) =>
              item.state === "done" && current.items.find((entry) => entry.id === item.id) !== item,
          )
          .flatMap((item) =>
            item.links.filter((link) => link.type === "ticket").map((link) => link.target),
          ),
      ),
    ];
    yield* Effect.forEach(ticketsToCheck, (key) => tracker.get(key, true), { concurrency: 2 });
    const live = yield* enrich(next);
    for (const item of live.items)
      if (item.state === "done") {
        const changed =
          current.items.find((entry) => entry.id === item.id) !==
          next.items.find((entry) => entry.id === item.id);
        if (changed && listItemNeedsHandoff(item))
          return yield* invalid(
            "An open or unavailable ticket or lane cannot be done. Use handed_off.",
          );
      }
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* write({
      ...next,
      revision: current.revision + 1,
      updatedAt: now,
      ...withTaskRefs({
        items: next.items.map(({ linkStates: _, ...item }) => item),
        lastTaskRef: next.lastTaskRef,
      }),
    });
  });
  // The message an agent relayed a task's outcome from, named only when it is the one user message
  // since the task was filed; a late relay could otherwise point at a later, unrelated message.
  const soleRelaySource = (actor: WriteActor, since: string) =>
    actor.by === "agent" && actor.threadId !== undefined
      ? orchestrator
          .getCurrentUserMessageId(actor.threadId, { soleSince: since })
          .pipe(Effect.mapError(storage))
      : Effect.succeed(null);
  // Reads the turn's user message only when a change claims it, from the caller's own thread.
  const actorOf = Effect.fnUntraced(function* (
    caller: ListCaller,
    changes: ThreadListUpdateInput["changes"],
  ) {
    if (caller.by === "user") return caller satisfies ListActor;
    const userMessageId =
      caller.threadId === undefined || !changes.some((change) => change.settledFromUser === true)
        ? null
        : yield* orchestrator
            .getCurrentUserMessageId(caller.threadId)
            .pipe(Effect.mapError(storage));
    return { by: "agent", userMessageId, threadId: caller.threadId } satisfies WriteActor;
  });
  const apply = Effect.fnUntraced(function* (
    current: Workspace,
    changes: ThreadListUpdateInput["changes"],
    now: string,
    actor: WriteActor,
    // A rewrite applies to an empty list but keeps the user-task fields of items it keeps by id.
    previous: ReadonlyArray<ListItem> = current.items,
  ) {
    const items = [...current.items];
    const changedIds = new Set<string>();
    for (const requested of changes) {
      // A user task's ref, such as T2, names it as well as its id.
      const resolved = resolveListItemId(previous, requested.id);
      if (typeof resolved === "string") return yield* invalid(resolved);
      const change = resolved.id === requested.id ? requested : { ...requested, id: resolved.id };
      const index = change.id === undefined ? -1 : items.findIndex((item) => item.id === change.id);
      const old = items[index];
      const before = old ?? previous.find((item) => item.id === change.id);
      const item = {
        id: change.id ?? old?.id ?? NodeCrypto.randomUUID(),
        text: change.text ?? old?.text ?? "",
        state: change.state ?? old?.state ?? "open",
        owner: change.owner ?? old?.owner ?? "agent",
        createdAt: old?.createdAt ?? now,
        doneAt: old?.doneAt ?? null,
        details: change.details ?? old?.details ?? "",
        parentId: change.parentId === undefined ? (old?.parentId ?? null) : change.parentId,
        links: change.links ?? old?.links ?? [],
        ...(old?.ref === undefined ? {} : { ref: old.ref }),
      } satisfies ListItem;
      item.doneAt = item.state === "done" || item.state === "dropped" ? (old?.doneAt ?? now) : null;
      const keys = item.text.match(/\bBW-\d+\b/g) ?? [];
      item.links = [
        ...item.links,
        ...[...new Set(keys)]
          .filter(
            (key) => !item.links.some((link) => link.type === "ticket" && link.target === key),
          )
          .map((target) => ({ type: "ticket" as const, target })),
      ];
      const changed = changeUserTask(before, item, change, actor, now);
      if (typeof changed === "string") return yield* invalid(changed);
      const task =
        changed.settledFromMessageId === undefined ||
        changed.settledFromMessageId === before?.settledFromMessageId ||
        (yield* soleRelaySource(actor, before?.createdAt ?? now)) === changed.settledFromMessageId
          ? changed
          : withoutRelaySource(changed);
      if (index < 0) items.push(task);
      else items[index] = task;
      changedIds.add(task.id);
    }
    return { items, changedIds };
  });
  // The orchestrator dedupes a command id, so a retry after a failed save with the same key
  // replays the send instead of posting a second message.
  const sendAnswers = Effect.fn("ThreadWorkspace.sendAnswers")(function* (
    current: Workspace,
    records: ReadonlyArray<ArtifactAnswerContextRecord>,
    keyed: string,
  ) {
    const owner = yield* requireThread(current.threadId);
    const serialized = yield* encodeSnapshot(records).pipe(Effect.mapError(storage));
    const key = NodeCrypto.createHash("sha256")
      .update(`${current.threadId}\n${keyed}\n${serialized}`)
      .digest("hex");
    yield* threads
      .sendToThread({
        origin: { kind: "user" },
        projectId: owner.projectId,
        threadId: current.threadId,
        commandId: CommandId.make(`artifact-submit:${key}`),
        messageId: MessageId.make(`artifact:${key}`),
        text: records
          .map(
            (record) =>
              `[${record.label}](${formatComposerContextHref("artifact-answer", record.contextId)})`,
          )
          .join("\n\n"),
        context: { version: 1, records: [...records] },
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadWorkspaceError({
              code: "thread",
              message: "Answers are saved; sending to chat failed. Retry sending.",
              cause,
            }),
        ),
      );
  });
  const commitQuestions = Effect.fn("ThreadWorkspace.commitQuestions")(function* (
    current: Workspace,
    questions: ReadonlyArray<ThreadQuestion>,
  ) {
    return yield* commit(current, { ...current, questions }, current.revision);
  });
  const findQuestion = (workspace: Workspace, id: string) => {
    const index = workspace.questions.findIndex((question) => question.id === id);
    return index < 0
      ? Effect.fail(missingQuestion(id))
      : Effect.succeed({ index, question: workspace.questions[index]! });
  };
  const StoredWorkspace = Schema.Struct({
    workspace: Schema.Struct({
      threadId: ThreadId,
      questions: Schema.optional(Schema.Array(Schema.Unknown)),
      asksRevision: Schema.optional(Schema.Number),
      asks: Schema.optional(Schema.Unknown),
      items: Schema.optional(
        Schema.Array(Schema.Struct({ owner: Schema.optional(Schema.String) })),
      ),
    }),
  });
  const storedWorkspaces = Effect.fn("ThreadWorkspace.storedWorkspaces")(function* (
    unreadable: "fail" | "skip" = "fail",
    includeAsks = false,
  ) {
    const files = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
      Effect.mapError(storage),
    );
    const stored: Array<{
      readonly threadId: ThreadId;
      readonly hasWaitingSources: boolean;
      readonly asks: ReadonlyArray<TrackedAsk>;
    }> = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const value = yield* fs.readFileString(path.join(directory, file)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredWorkspace))),
        Effect.filterOrFail(
          (decoded) => filePath(decoded.workspace.threadId) === path.join(directory, file),
          () => "Thread identity mismatch.",
        ),
        Effect.mapError(storage),
        Effect.catchIf(
          () => unreadable === "skip",
          (cause) =>
            Effect.logWarning("Skipped an unreadable thread workspace.", { file, cause }).pipe(
              Effect.as(undefined),
            ),
        ),
      );
      if (value === undefined) continue;
      const asks =
        includeAsks && value.workspace.asks !== undefined
          ? yield* decodeStoredAsks(value.workspace.asks).pipe(Effect.mapError(storage))
          : [];
      stored.push({
        threadId: value.workspace.threadId,
        asks,
        // Questions are never deleted, and a user task stays in the list once done.
        hasWaitingSources:
          (value.workspace.questions?.length ?? 0) > 0 ||
          value.workspace.asksRevision !== undefined ||
          (value.workspace.items ?? []).some((item) => item.owner === "you"),
      });
    }
    return stored;
  });
  const get = Effect.fn("ThreadWorkspace.get")(function* (input: ThreadWorkspaceGetInput) {
    return yield* enrich(yield* read(input.threadId, "drafts"));
  }, lock.withPermit);
  const saveAsks = Effect.fn("ThreadWorkspace.saveAsks")(function* (
    current: Workspace,
    next: Workspace,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* write({
      ...next,
      revision: current.revision + 1,
      asksRevision: (current.asksRevision ?? 0) + 1,
      updatedAt: now,
    });
  });
  const saveAsk = Effect.fn("ThreadWorkspace.saveAsk")(function* (
    current: Workspace,
    next: TrackedAsk,
  ) {
    yield* saveAsks(current, {
      ...current,
      asks: (current.asks ?? []).map((ask) => (ask.id === next.id ? next : ask)),
    });
    return next;
  });
  const recordTrackedMessages = Effect.fn("ThreadWorkspace.recordTrackedMessages")(function* (
    threadId: ThreadId,
    messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
    delivered: boolean,
    editing = false,
  ) {
    const userMessages = messages.filter(
      (message) =>
        message.threadId === threadId &&
        message.role === "user" &&
        message.createdBy === "user" &&
        (message.origin?.kind ?? "user") === "user" &&
        message.context?.guest === undefined &&
        (editing ||
          message.context?.trackedAsk !== undefined ||
          message.context?.discussAnswers?.length),
    );
    if (userMessages.length === 0) return [];
    const current = yield* load(threadId);
    const next = { ...current };
    let changed = false;
    for (const message of userMessages) {
      const tracking = message.context?.trackedAsk;
      const discussedIds = message.context?.discussAnswers;
      const at = DateTime.formatIso(message.createdAt);
      if (discussedIds?.length) {
        const asks = (next.asks ?? []).map((ask): TrackedAsk => {
          if (
            !discussedIds.includes(ask.id) ||
            ask.state !== "answered" ||
            ask.followUps.some((followUp) => followUp.messageId === message.id)
          )
            return ask;
          return {
            ...ask,
            state: "owed",
            followUps: [...ask.followUps, { messageId: message.id, at }],
          };
        });
        if (asks.some((ask, index) => ask !== next.asks?.[index])) {
          next.asks = asks;
          changed = true;
        }
      }
      const previous = next.asks?.find((ask) => ask.askedInMessageId === message.id);
      if (tracking === undefined) {
        if (editing && previous?.state === "queued") {
          next.asks = next.asks?.filter((ask) => ask.id !== previous.id) ?? [];
          changed = true;
        }
        continue;
      }
      if (previous === undefined) {
        const added = addTrackedAsk(
          next,
          {
            askedInMessageId: message.id,
            question: tracking.question,
            ...(tracking.about === undefined ? {} : { about: tracking.about }),
            createdAt: at,
          },
          delivered ? "owed" : "queued",
        ).workspace;
        next.asks = added.asks;
        next.lastAskRef = added.lastAskRef;
        changed = true;
      } else if (previous.state === "queued") {
        const question =
          previous.userChangedAt === undefined ? tracking.question : previous.question;
        if (delivered || question !== previous.question) {
          next.asks =
            next.asks?.map((ask) =>
              ask.id !== previous.id
                ? ask
                : { ...ask, question, state: delivered ? "owed" : "queued" },
            ) ?? [];
          changed = true;
        }
      }
    }
    if (changed) yield* saveAsks(current, next);
    const ids = new Set(userMessages.map((message) => message.id));
    return (next.asks ?? []).filter(
      (ask) =>
        ids.has(ask.askedInMessageId) || ask.followUps.some((entry) => ids.has(entry.messageId)),
    );
  }, lock.withPermit);
  const recordTrackedRunRemoval = Effect.fn("ThreadWorkspace.recordTrackedRunRemoval")(function* (
    threadId: ThreadId,
    run: import("@t3tools/contracts").OrchestrationV2Run,
  ) {
    if (run.status !== "rolled_back" && (run.status !== "cancelled" || run.mergedIntoRunId)) return;
    const current = yield* load(threadId);
    const messages = new Set(run.inputMessageIds ?? [run.userMessageId]);
    const asks = current.asks ?? [];
    const next =
      run.status === "rolled_back"
        ? asks.map((ask) => rollBackTrackedAsk(ask, messages, run.id))
        : asks.filter((ask) => ask.state !== "queued" || !messages.has(ask.askedInMessageId));
    if (next.length !== asks.length || next.some((ask, index) => ask !== asks[index]))
      yield* saveAsks(current, { ...current, asks: next });
  }, lock.withPermit);
  return ThreadWorkspace.of({
    get,
    recordTrackedMessages,
    asksRead: Effect.fn("ThreadWorkspace.asksRead")(function* (input) {
      const all = "all" in input;
      // The history scan reads atomic file snapshots. Checklist repairs belong to the regular load.
      const workspaces = all
        ? (yield* storedWorkspaces("skip", true)).filter(({ asks }) => asks.length > 0)
        : [{ threadId: input.threadId, asks: undefined }];
      const entries: Array<TrackedAnswersPage["entries"][number]> = [];
      for (const { threadId, asks } of workspaces) {
        const thread = yield* requireThread(threadId).pipe(
          Effect.catchIf(
            (error) => all && error.code === "not_found",
            () => Effect.succeed(null),
          ),
        );
        if (thread === null) continue;
        const savedAsks = asks ?? (yield* load(threadId).pipe(lock.withPermit)).asks ?? [];
        for (const ask of savedAsks) {
          entries.push({
            threadId,
            threadTitle: thread.title,
            archived: thread.archivedAt !== null,
            ask,
          });
        }
      }
      const counts = {
        owed: entries.filter(({ ask }) => ask.state === "queued" || ask.state === "owed").length,
        toRead: entries.filter(({ ask }) => ask.state === "answered").length,
        closed: entries.filter(({ ask }) => ask.state === "closed").length,
      };
      if (!all) return { entries, counts };
      const key = (entry: TrackedAnswersPage["entries"][number]) =>
        `${entry.ask.createdAt}/${entry.threadId}/${entry.ask.id}`;
      const cursor = input.cursor;
      const sorted = entries
        .filter((entry) => cursor === undefined || key(entry) < cursor)
        .sort((a, b) => (key(a) < key(b) ? 1 : -1));
      const page = sorted.slice(0, 50);
      return {
        entries: page,
        counts,
        ...(sorted.length > page.length ? { cursor: key(page[page.length - 1]!) } : {}),
      };
    }),
    trackMessage: Effect.fn("ThreadWorkspace.trackMessage")(function* (input) {
      const current = yield* read(input.threadId);
      if (current.asks?.some((ask) => ask.askedInMessageId === input.messageId))
        return yield* invalidAsk("That message already has a tracked answer.");
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["messages"], { messageIds: [input.messageId] })
        .pipe(Effect.mapError(storage));
      const message = records.messages.find((candidate) => candidate.id === input.messageId);
      if (message === undefined)
        return yield* new ThreadWorkspaceError({
          code: "not_found",
          message: "Message not found.",
        });
      if (
        message.role !== "user" ||
        message.createdBy !== "user" ||
        (message.origin?.kind ?? "user") !== "user" ||
        message.context?.guest !== undefined
      )
        return yield* invalidAsk("You can only track an answer to your own message.");
      const { ask, workspace } = addTrackedAsk(
        current,
        {
          ...trackedAskContextForMessage(message.text, message.context?.records ?? []),
          askedInMessageId: message.id,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        },
        "owed",
      );
      yield* saveAsks(current, workspace);
      return ask;
    }, lock.withPermit),
    updateAsk: Effect.fn("ThreadWorkspace.updateAsk")(function* (input) {
      const current = yield* read(input.threadId);
      const ask = current.asks?.find((candidate) => candidate.id === input.id);
      if (ask === undefined) return yield* missingAsk(input.id);
      const next = updateTrackedAsk(ask, input, DateTime.formatIso(yield* DateTime.now));
      if (isWorkspaceError(next)) return yield* next;
      return yield* saveAsk(current, next);
    }, lock.withPermit),
    answerAsk: Effect.fn("ThreadWorkspace.answerAsk")(function* (input) {
      if (input.text.length > 4000)
        return yield* invalidAsk(
          "Keep the answer under 4000 characters, and pass the rest as more.",
        );
      if (!isTrackedAnswerText(input.text)) return yield* invalidAsk("Give a nonempty answer.");
      if (input.more !== undefined && !isTrackedAnswerMore(input.more))
        return yield* invalidAsk("Keep the link or path under 2000 characters.");
      const thread = yield* requireThread(input.threadId);
      const current = yield* load(input.threadId);
      const ask = current.asks?.find((candidate) => candidate.id === input.id);
      if (ask === undefined) {
        const parent = thread.lineage.parentThreadId;
        if (thread.lineage.relationshipToParent === "subagent" && parent != null) {
          const parentWork = yield* load(parent);
          if (
            parentWork.asks?.some(
              (candidate) => candidate.id === input.id && candidate.state === "owed",
            )
          )
            return yield* invalidAsk(
              `${input.id} belongs to your lead's thread. Put the answer in your result; the lead gives it.`,
            );
        }
        return yield* missingAsk(input.id);
      }
      const next = appendTrackedAnswer(ask, {
        text: input.text,
        ...(input.more === undefined ? {} : { more: input.more }),
        answeredAt: DateTime.formatIso(yield* DateTime.now),
        runId:
          input.runId === undefined
            ? ((yield* orchestrator
                .getThreadRecords(input.threadId, ["runs"])
                .pipe(Effect.mapError(storage))).runs.findLast((run) => run.status === "running")
                ?.id ?? null)
            : input.runId,
      });
      if (isWorkspaceError(next)) return yield* next;
      yield* saveAsk(current, next);
      return next.answers[next.answers.length - 1]!;
    }, lock.withPermit),
    update: Effect.fn("ThreadWorkspace.update")(function* (input, caller) {
      const current = yield* read(input.threadId);
      const applied = yield* apply(
        current,
        input.changes,
        DateTime.formatIso(yield* DateTime.now),
        yield* actorOf(caller, input.changes),
      );
      let items = applied.items;
      if (input.order !== undefined) {
        if (
          new Set(input.order).size !== items.length ||
          input.order.length !== items.length ||
          input.order.some((id) => !items.some((item) => item.id === id))
        )
          return yield* invalid("Order must contain every item once.");
        const order = input.order;
        items = items.toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      }
      if (filedCount(current, items, applied.changedIds) > LIST_FILED_TASKS_LIMIT)
        return yield* invalid(TOO_MANY_FILED);
      const workspace = yield* commit(
        current,
        {
          ...current,
          items,
          summaryNotes: input.summaryNotes ?? current.summaryNotes,
          childPreamble: input.childPreamble ?? current.childPreamble,
        },
        input.expectedRevision,
      );
      return listWrite(current, workspace, applied.changedIds);
    }, lock.withPermit),
    rewrite: Effect.fn("ThreadWorkspace.rewrite")(function* (input, caller) {
      const current = yield* read(input.threadId);
      const retained = current.items.filter((item) => item.state !== "open");
      for (const change of input.items) {
        const resolved = resolveListItemId(current.items, change.id);
        if (typeof resolved === "string") return yield* invalid(resolved);
        if (resolved.id !== undefined && retained.some((item) => item.id === resolved.id))
          return yield* invalid("Rewrite cannot change finished or handed-off history.");
      }
      // A task kept by id keeps its number.
      const actor = yield* actorOf(caller, input.items);
      const rewritten = yield* apply(
        { ...current, items: [] },
        input.items,
        DateTime.formatIso(yield* DateTime.now),
        actor,
        current.items,
      );
      const replacements = rewritten.items.map((item) => {
        const ref = current.items.find((entry) => entry.id === item.id)?.ref;
        return ref === undefined || item.ref !== undefined ? item : { ...item, ref };
      });
      // Checked against the rows the rewrite actually writes, so no spelling of an id can hide one.
      if (
        actor.by === "agent" &&
        removedOpenTasks(current.items, new Set(replacements.map((item) => item.id))).length > 0
      )
        return yield* invalid(TASK_LEAVES_ONLY_CLOSED);
      const survivingIds = new Set([...retained, ...replacements].map((item) => item.id));
      const history = retained.map((item) => {
        let parentId = item.parentId;
        while (parentId !== null && !survivingIds.has(parentId))
          parentId = current.items.find((entry) => entry.id === parentId)?.parentId ?? null;
        return parentId === item.parentId ? item : { ...item, parentId };
      });
      if (filedCount(current, replacements, rewritten.changedIds) > LIST_FILED_TASKS_LIMIT)
        return yield* invalid(TOO_MANY_FILED);
      const workspace = yield* commit(
        current,
        { ...current, items: [...history, ...replacements] },
        input.expectedRevision,
      );
      return listWrite(current, workspace, rewritten.changedIds);
    }, lock.withPermit),
    waitingWork: Effect.fn("ThreadWorkspace.waitingWork")(function* (threadId) {
      const workspace = yield* read(threadId);
      return {
        questions: workspace.questions,
        tasks: workspace.items.filter(isUserTask),
        asks: workspace.asks ?? [],
      };
    }, lock.withPermit),
    markDiscussed: Effect.fn("ThreadWorkspace.markDiscussed")(function* (input) {
      const current = yield* load(input.threadId);
      const questionIds = new Set(input.questionIds);
      const taskIds = new Set(input.taskIds);
      let changed = false;
      const questions = current.questions.map((question) => {
        if (!questionIds.has(question.id) || !isWaiting(question)) return question;
        changed = true;
        return { ...question, discussedInMessageId: input.messageId };
      });
      const items = current.items.map((item) => {
        if (!taskIds.has(item.id) || !isUserTask(item) || item.state !== "open") return item;
        changed = true;
        return { ...item, discussedInMessageId: input.messageId };
      });
      // Like answer delivery, nothing the user or agent wrote changed, so the revision stays.
      if (changed) yield* write({ ...current, questions, items });
    }, lock.withPermit),
    listRead: Effect.fn("ThreadWorkspace.listRead")(function* (input) {
      if (!input.allThreads && input.threadId === undefined)
        return yield* invalid("Choose a thread or allThreads.");
      const ids: ThreadId[] = [];
      if (input.allThreads)
        ids.push(...(yield* storedWorkspaces()).map((stored) => stored.threadId));
      else if (input.threadId !== undefined) ids.push(input.threadId);
      const entries: ThreadListEntry[] = [];
      for (const id of ids) {
        const thread = yield* requireThread(id).pipe(
          Effect.catchIf(
            (e) => e.code === "not_found",
            () => Effect.succeed(null),
          ),
        );
        if (thread === null) continue;
        const workspace = yield* enrich(yield* read(id));
        entries.push({
          threadId: id,
          threadTitle: thread.title,
          revision: workspace.revision,
          summaryNotes: workspace.summaryNotes,
          childPreamble: workspace.childPreamble,
          items: workspace.items.filter(
            (item) => input.all || item.state === "open" || item.state === "handed_off",
          ),
        });
      }
      return entries;
    }, lock.withPermit),
    artifactWrite: Effect.fn("ThreadWorkspace.artifactWrite")(function* (input) {
      const current = yield* read(input.threadId);
      const id = input.id ?? NodeCrypto.randomUUID();
      const old = current.artifacts.find((artifact) => artifact.id === id);
      const questions = yield* Effect.try({
        try: () => (input.format === "markdown" ? parseArtifactQuestions(input.content) : []),
        catch: (cause) => invalid(`Invalid question block: ${cause}`),
      });
      const previous = old?.versions.at(-1);
      const answers = Object.fromEntries(
        questions.flatMap((question) => {
          const answer = previous?.answers[question.id];
          return answer &&
            NodeUtil.isDeepStrictEqual(
              previous?.questions.find((q) => q.id === question.id),
              question,
            )
            ? [[question.id, answer]]
            : [];
        }),
      );
      const version = {
        questions,
        answers,
        version: (old?.versions.at(-1)?.version ?? 0) + 1,
        title: input.title,
        format: input.format,
        content: input.content,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      const artifact = {
        id,
        title: input.title,
        format: input.format,
        versions: [...(old?.versions ?? []), version],
      };
      return yield* commit(
        current,
        {
          ...current,
          artifacts: [...current.artifacts.filter((entry) => entry.id !== id), artifact],
        },
        input.expectedRevision,
      );
    }, lock.withPermit),
    artifactAnswer: Effect.fn("ThreadWorkspace.artifactAnswer")(function* (input) {
      const current = yield* read(input.threadId);
      const artifact = current.artifacts.find((entry) => entry.id === input.id);
      const version = artifact?.versions.at(-1);
      if (!version || version.version !== input.version)
        return yield* invalid("Answer the latest artifact version.");
      const answers = { ...version.answers };
      for (const [id, answer] of Object.entries(input.answers)) {
        const question = version.questions.find((q) => q.id === id);
        if (
          !question ||
          new Set(answer.chosenOptionIds).size !== answer.chosenOptionIds.length ||
          (!question.multiSelect && answer.chosenOptionIds.length > 1) ||
          answer.chosenOptionIds.some(
            (choice) => !question.options.some((option) => option.id === choice),
          )
        )
          return yield* invalid("Answer choices must match the question.");
        answers[id] = { ...answer, submittedAt: null, draftRevision: current.revision + 1 };
      }
      return yield* commit(
        current,
        {
          ...current,
          artifacts: current.artifacts.map((entry) =>
            entry.id !== input.id
              ? entry
              : {
                  ...entry,
                  versions: entry.versions.map((v) =>
                    v.version !== input.version ? v : { ...v, answers },
                  ),
                },
          ),
        },
        input.expectedRevision,
      );
    }, lock.withPermit),
    artifactSubmit: Effect.fn("ThreadWorkspace.artifactSubmit")(function* (input) {
      const current = yield* read(input.threadId);
      if (current.revision !== input.expectedRevision)
        return yield* new ThreadWorkspaceError({
          code: "conflict",
          message: "Read the artifact again before sending answers.",
          currentRevision: current.revision,
        });
      const artifact = current.artifacts.find((entry) => entry.id === input.id);
      const version = artifact?.versions.at(-1);
      if (
        !artifact ||
        !version ||
        version.version !== input.version ||
        !input.questionIds.length ||
        new Set(input.questionIds).size !== input.questionIds.length
      )
        return yield* invalid("Choose questions in the latest artifact version.");
      const records = [];
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const id of input.questionIds) {
        const question = version.questions.find((q) => q.id === id);
        const answer = version.answers[id];
        if (!question || !answer || (!answer.chosenOptionIds.length && !answer.notes.trim()))
          return yield* invalid("Choose an answer or add a note before sending.");
        if (answer.submittedAt !== null) continue;
        const key = NodeCrypto.createHash("sha256")
          .update(
            yield* encodeSnapshot([artifact.id, version.version, question, answer]).pipe(
              Effect.mapError(storage),
            ),
          )
          .digest("hex");
        records.push({
          contextId: ComposerContextId.make(`answer_${key}`),
          kind: "artifact-answer" as const,
          label: sanitizeComposerContextLabel(version.title, "artifact-answer"),
          artifactId: artifact.id,
          questionId: question.id,
          answerRevision: answer.draftRevision ?? 0,
          title: version.title.slice(0, 200),
          version: 1 as const,
          artifactVersion: version.version,
          question: question.prompt,
          choice: question.options
            .filter((option) => answer.chosenOptionIds.includes(option.id))
            .map((option) => option.label)
            .join(", "),
          note: answer.notes,
        });
      }
      if (!records.length) return current;
      yield* sendAnswers(current, records, String(current.revision));
      const answers = { ...version.answers };
      for (const id of input.questionIds)
        answers[id] = { ...answers[id]!, submittedAt: answers[id]?.submittedAt ?? now };
      return yield* commit(
        current,
        {
          ...current,
          artifacts: current.artifacts.map((entry) =>
            entry.id !== artifact.id
              ? entry
              : {
                  ...entry,
                  versions: entry.versions.map((v) =>
                    v.version !== version.version ? v : { ...v, answers },
                  ),
                },
          ),
        },
        input.expectedRevision,
      );
    }, lock.withPermit),
    questionAsk: Effect.fn("ThreadWorkspace.questionAsk")(function* (input) {
      const current = yield* read(input.threadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const questions = [...current.questions];
      for (const ask of input.questions) {
        // Questions are never deleted, so a position-based id is never reused in a thread.
        const question: ThreadQuestion = {
          id: `Q${questions.length + 1}`,
          prompt: ask.prompt,
          ...(ask.details === undefined ? {} : { details: ask.details }),
          options: (ask.options ?? []).map((option) => ({
            id: option.id,
            label: option.label,
            description: option.description ?? "",
          })),
          recommendedOptionIds: ask.recommendedOptionIds ?? [],
          multiSelect: ask.multiSelect ?? false,
          state: "open",
          createdAt: now,
          closedAt: null,
          answer: null,
          answeredBy: null,
          replacedBy: null,
        };
        if (!artifactQuestionIsConsistent(question))
          return yield* invalid(
            `Option ids and recommendations of "${threadQuestionTitle(ask.prompt)}" must match its options.`,
          );
        if (ask.replaces !== undefined) {
          const { index, question: old } = yield* findQuestion(
            { ...current, questions },
            ask.replaces,
          );
          if (!isWaiting(old))
            return yield* invalid(
              `${old.id} is ${old.state}; only an open or deferred question can be replaced.`,
            );
          const { discussedInMessageId: _discussed, ...replaced } = old;
          questions[index] = {
            ...replaced,
            state: "replaced",
            closedAt: now,
            replacedBy: question.id,
          };
        }
        questions.push(question);
      }
      return yield* commitQuestions(current, questions);
    }, lock.withPermit),
    questionUpdate: Effect.fn("ThreadWorkspace.questionUpdate")(function* (input, by) {
      // A full scan, so an answer already queued is marked sent before a revision can change.
      const current = yield* read(input.threadId, "drafts");
      const { index, question } = yield* findQuestion(current, input.id);
      const now = DateTime.formatIso(yield* DateTime.now);
      let next: ThreadQuestion;
      switch (input.state) {
        case "open": {
          if (question.state === "open") return yield* invalid(`${question.id} is already open.`);
          // An answer still on its way stays sent; the question only rejoins the waiting group.
          if (question.state === "deferred" && question.sentInMessageId !== undefined) {
            next = { ...question, state: "open" };
            break;
          }
          const { sentInMessageId: _sent, settledFromMessageId: _settled, ...rest } = question;
          next = {
            ...rest,
            state: "open",
            closedAt: null,
            answeredBy: null,
            replacedBy: null,
            // A new revision, so resubmitting the same answer sends a new message.
            answer: question.answer && {
              ...question.answer,
              submittedAt: null,
              draftRevision: current.revision + 1,
            },
          };
          break;
        }
        case "deferred":
          if (question.state !== "open")
            return yield* invalid(
              `${question.id} is ${question.state}; only an open question can be deferred.`,
            );
          next = { ...question, state: "deferred" };
          break;
        case "withdrawn":
          if (!isWaiting(question))
            return yield* invalid(`${question.id} is already ${question.state}.`);
          next = { ...question, state: "withdrawn", closedAt: now };
          break;
        case "answered": {
          // The user's submit already recorded it; an agent following its instructions after
          // reading that message has nothing left to do.
          if (by === "agent" && question.state === "answered" && question.answeredBy === "user")
            return current;
          if (!isWaiting(question))
            return yield* invalid(`${question.id} is already ${question.state}.`);
          if (by === "user")
            return yield* invalid("Send answers with a message so the agent receives them.");
          const chosenOptionIds = input.answer?.chosenOptionIds ?? [];
          const notes = input.answer?.notes ?? "";
          if (!chosenOptionIds.length && !notes.trim())
            return yield* invalid(`Record the answer to ${question.id} as you understood it.`);
          if (!artifactAnswerFits(question, chosenOptionIds))
            return yield* invalid(`Answer choices must be options of ${question.id}.`);
          // The question tool acts on the agent's own thread, so this is the agent's current turn.
          // Only the one user message since the question was asked can be the answer's source.
          const settledFromMessageId = yield* orchestrator
            .getCurrentUserMessageId(input.threadId, { soleSince: question.createdAt })
            .pipe(Effect.mapError(storage));
          next = {
            ...question,
            state: "answered",
            closedAt: now,
            answeredBy: "agent",
            answer: { chosenOptionIds, notes, submittedAt: now },
            ...(settledFromMessageId === null ? {} : { settledFromMessageId }),
          };
          break;
        }
      }
      const { userChangedAt: _reported, discussedInMessageId: previous, ...changed } = next;
      // The agent reopening the user's answer is answering back, so the answer's message starts
      // a discussion; any other reopening, and every change of the user's own, ends one.
      // A defer keeps a discussion; an answer or withdrawal closes the question and ends it.
      const discussed =
        input.state === "deferred"
          ? previous
          : input.state === "open" &&
              by === "agent" &&
              question.state === "answered" &&
              question.answeredBy === "user"
            ? question.sentInMessageId
            : undefined;
      const questions = [...current.questions];
      // A new draft revision keeps a comment still queued from matching again; a sent answer keeps
      // its revision.
      const kept =
        by === "user" || discussed === undefined
          ? by === "user" && changed.answer && changed.sentInMessageId === undefined
            ? { ...changed, answer: { ...changed.answer, draftRevision: current.revision + 1 } }
            : changed
          : { ...changed, discussedInMessageId: discussed };
      questions[index] = by === "user" ? { ...kept, userChangedAt: now } : kept;
      return yield* commitQuestions(current, questions);
    }, lock.withPermit),
    questionDraft: Effect.fn("ThreadWorkspace.questionDraft")(function* (input) {
      // A full scan, so a message accepted before the follower marked it still blocks the edit.
      const current = yield* read(input.threadId, "drafts");
      const questions = [...current.questions];
      for (const [id, answer] of Object.entries(input.answers)) {
        const { index, question } = yield* findQuestion(current, id);
        if (!isWaiting(question))
          return yield* invalid(`${id} is ${question.state}; reopen it to answer.`);
        if (question.sentInMessageId !== undefined)
          return yield* invalid(
            `${id} was sent with a message; edit or cancel that message to change it.`,
          );
        if (!artifactAnswerFits(question, answer.chosenOptionIds))
          return yield* invalid(`Answer choices must be options of ${id}.`);
        // A new draft ends the discussion it followed.
        const { discussedInMessageId: _discussed, ...rest } = question;
        questions[index] = {
          ...rest,
          answer: { ...answer, submittedAt: null, draftRevision: current.revision + 1 },
        };
      }
      return yield* commitQuestions(current, questions);
    }, lock.withPermit),
    artifactRead: Effect.fn("ThreadWorkspace.artifactRead")(function* (input) {
      const workspace = yield* read(input.threadId);
      const artifact = workspace.artifacts.find((entry) => entry.id === input.id);
      const version =
        input.version === undefined
          ? artifact?.versions.at(-1)
          : artifact?.versions.find((entry) => entry.version === input.version);
      if (!version)
        return yield* new ThreadWorkspaceError({
          code: "not_found",
          message: "Artifact version not found.",
        });
      return {
        ...version,
        answers: Object.fromEntries(
          Object.entries(version.answers).filter(([, answer]) => answer.submittedAt !== null),
        ),
      };
    }, lock.withPermit),
    waitingItems: Effect.fn("ThreadWorkspace.waitingItems")(
      function* (threadId) {
        const workspace = yield* read(threadId, "drafts");
        const refs = withTaskRefs(workspace);
        const numbered = refs === workspace ? workspace : yield* write(refs);
        const items = [...questionWaitingItems(numbered), ...taskWaitingItems(numbered)];
        if (workspace.asksRevision === undefined) return { items };
        const answers = (workspace.asks ?? []).flatMap((ask): TrackedAnswerWaitingRow[] =>
          ask.state === "closed" || ask.state === "withdrawn"
            ? []
            : [{ ref: ask.id, title: threadQuestionTitle(ask.question), state: ask.state }],
        );
        return { items, answers, answersRevision: workspace.asksRevision };
      },
      lock.withPermit,
      // A deleted thread waits on nobody.
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed({ items: [] }),
      ),
    ),
    withTrackedAnswers: (threadId, stream) =>
      Stream.suspend(() => {
        let sawSnapshot = false;
        let revision: number | undefined;
        const readAsks = load(threadId).pipe(
          lock.withPermit,
          Effect.map((workspace) => workspace.asks ?? []),
          Effect.catch((error) =>
            Effect.logWarning("Could not read tracked answers.", { threadId, error }).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        return stream.pipe(
          Stream.mapEffect(
            Effect.fnUntraced(function* (item) {
              if (item.kind === "snapshot") {
                sawSnapshot = true;
                revision = item.projection.thread.trackedAnswersRevision;
                const trackedAsks = yield* readAsks;
                return trackedAsks === undefined
                  ? item
                  : {
                      ...item,
                      projection: {
                        ...item.projection,
                        thread: { ...item.projection.thread, trackedAsks },
                      },
                    };
              }
              if (item.kind === "synchronized" && !sawSnapshot) {
                const trackedAsks = yield* readAsks;
                return trackedAsks === undefined ? item : { ...item, trackedAsks };
              }
              if (
                item.kind === "event" &&
                item.event.type === "thread.tags-updated" &&
                item.event.payload.trackedAnswersRevision !== revision
              ) {
                revision = item.event.payload.trackedAnswersRevision;
                const trackedAsks = yield* readAsks;
                return trackedAsks === undefined
                  ? item
                  : {
                      ...item,
                      event: { ...item.event, payload: { ...item.event.payload, trackedAsks } },
                    };
              }
              return item;
            }),
          ),
        );
      }),
    waitingThreads: storedWorkspaces("skip").pipe(
      Effect.map((stored) =>
        stored.filter((entry) => entry.hasWaitingSources).map((entry) => entry.threadId),
      ),
      Effect.withSpan("ThreadWorkspace.waitingThreads"),
    ),
    changes: Stream.fromPubSub(written),
    followQuestionDeliveries: Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      Effect.gen(function* () {
        if (event.type === "message.updated") {
          if (event.payload.role !== "user") return;
          if (event.payload.context?.trackedAsk || event.payload.context?.discussAnswers?.length)
            yield* recordTrackedMessages(event.threadId, [event.payload], false);
          // A provider's acceptance can arrive alone, as its turn record, and it is what clears
          // a sent comment's note and closes a sent answer.
        } else if (event.type === "run.updated") {
          yield* recordTrackedRunRemoval(event.threadId, event.payload);
        } else if (event.type !== "provider-turn.updated") return;
        const carriesAnswer =
          event.type === "message.updated" &&
          (event.payload.context?.records.some(
            (record) =>
              record.kind === "artifact-answer" &&
              "artifactId" in record &&
              (record.artifactId === THREAD_QUESTIONS_ARTIFACT_ID ||
                record.artifactId === THREAD_QUESTION_COMMENTS_ARTIFACT_ID),
          ) ??
            false);
        if (!carriesAnswer) {
          // A start, cancel or edit only matters to an answer or comment already sent, which
          // only a waiting question can have.
          const { thread } = yield* orchestrator.getThreadRecords(event.threadId, []);
          if (
            !(thread.waiting ?? []).some(
              (item) => item.kind === "question" && item.state !== "dismissed",
            )
          )
            return;
        }
        yield* read(event.threadId, "drafts").pipe(lock.withPermit);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not follow a question answer's delivery.", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Question delivery event stream failed.", { cause }),
      ),
      Effect.withSpan("ThreadWorkspace.followQuestionDeliveries"),
    ),
    artifactList: Effect.fn("ThreadWorkspace.artifactList")(function* (input) {
      const workspace = yield* read(input.threadId);
      return workspace.artifacts.flatMap((artifact) => {
        const latest = artifact.versions.at(-1);
        return latest
          ? [
              {
                id: artifact.id,
                title: latest.title,
                format: latest.format,
                version: latest.version,
                createdAt: latest.createdAt,
                unansweredQuestions: latest.questions.filter(
                  (q) => !latest.answers[q.id]?.submittedAt,
                ).length,
              },
            ]
          : [];
      });
    }, lock.withPermit),
  });
});
export const layer = Layer.effect(ThreadWorkspace, make);
export const layerTest = Layer.mock(ThreadWorkspace)({
  get: ({ threadId }) => Effect.succeed(emptyWorkspace(threadId)),
});
