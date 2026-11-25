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
  THREAD_QUESTIONS_ARTIFACT_ID,
  threadQuestionTitle,
  type ArtifactAnswerContextRecord,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadQuestionSummary,
  type ThreadQuestion,
  type ThreadQuestionAskInput,
  type ThreadQuestionDraftInput,
  type ThreadQuestionSubmitInput,
  type ThreadQuestionUpdateInput,
  type ThreadArtifactAnswerInput,
  type ThreadArtifactSubmitInput,
  listItemNeedsHandoff,
  type ListItem,
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
import * as TicketTracker from "../ticketTracker/TicketTracker.ts";
import { LegacyWorkspace, migrateWorkspace, cleanMigratedDetails } from "./workspaceMigration.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  formatComposerContextHref,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";
import { migrateAnnotations } from "./ThreadMarks.ts";

export class ThreadWorkspace extends Context.Service<
  ThreadWorkspace,
  {
    readonly get: (
      input: ThreadWorkspaceGetInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly listRead: (
      input: ThreadListReadInput,
    ) => Effect.Effect<ReadonlyArray<ThreadListEntry>, ThreadWorkspaceError>;
    readonly update: (
      input: ThreadListUpdateInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly rewrite: (
      input: ThreadListRewriteInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
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
    /** Only the agent records an answer here; the user answers through drafts and submit. */
    readonly questionUpdate: (
      input: ThreadQuestionUpdateInput,
      by: "user" | "agent",
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    readonly questionDraft: (
      input: ThreadQuestionDraftInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    /** Answers every listed question in one user message, so they start one turn. */
    readonly questionSubmit: (
      input: ThreadQuestionSubmitInput,
    ) => Effect.Effect<Workspace, ThreadWorkspaceError>;
    /**
     * Repairs every thread's question mirror from its workspace file, archived threads included,
     * so a sync lost to a crash or a failed dispatch heals without a visit. Returns threads checked.
     */
    readonly reconcileQuestions: Effect.Effect<number, ThreadWorkspaceError>;
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
const missingQuestion = (id: string) =>
  new ThreadWorkspaceError({ code: "not_found", message: `${id} does not exist in this thread.` });

/** The first words of a question, for the thread list and an agent's turn context. */
const isWaiting = (
  question: ThreadQuestion,
): question is ThreadQuestion & { readonly state: "open" | "deferred" } =>
  question.state === "open" || question.state === "deferred";
// A withdrawn question stays mirrored while the user's dismissal is unreported history, so the
// agent's next user-message turn can name it; the turn filters by time.
const mirroredQuestions = (
  workspace: Pick<Workspace, "questions">,
): ReadonlyArray<OrchestrationV2ThreadQuestionSummary> =>
  workspace.questions.flatMap((question) =>
    isWaiting(question) || (question.state === "withdrawn" && question.userChangedAt)
      ? [
          {
            id: question.id,
            title: threadQuestionTitle(question.prompt),
            state: question.state as "open" | "deferred" | "withdrawn",
            ...(question.userChangedAt ? { userChangedAt: question.userChangedAt } : {}),
          },
        ]
      : [],
  );
const choiceLabels = (question: ThreadQuestion, chosenOptionIds: ReadonlyArray<string>) =>
  question.options
    .filter((option) => chosenOptionIds.includes(option.id))
    .map((option) => option.label)
    .join(", ");
const storage = (cause: unknown) =>
  new ThreadWorkspaceError({
    code: "storage",
    message: "Could not read or save the thread list.",
    cause,
  });
const Envelope = Schema.Struct({ formatVersion: Schema.Literal(3), workspace: Workspace });
const decode = Schema.decodeEffect(Schema.fromJsonString(Envelope));
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
  // The thread mirrors waiting questions so the sidebar count needs no workspace reads. A failed
  // dispatch leaves the mirror stale until the next read of this workspace or the startup
  // reconcile repairs it.
  const syncQuestions = Effect.fn("ThreadWorkspace.syncQuestions")(function* (
    mirrored: ReadonlyArray<OrchestrationV2ThreadQuestionSummary>,
    workspace: Workspace,
  ) {
    const questions = mirroredQuestions(workspace);
    if (NodeUtil.isDeepStrictEqual(mirrored, questions)) return;
    yield* orchestrator
      .dispatch({
        type: "thread.questions.sync",
        commandId: CommandId.make(`questions-sync:${NodeCrypto.randomUUID()}`),
        threadId: workspace.threadId,
        questions: [...questions],
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not mirror thread questions; the next read retries.", {
            threadId: workspace.threadId,
            cause,
          }),
        ),
      );
  });
  const read = Effect.fn("ThreadWorkspace.read")(function* (threadId: ThreadId) {
    const thread: OrchestrationV2AppThread = yield* requireThread(threadId);
    const workspace = yield* load(threadId);
    yield* syncQuestions(thread.questions ?? [], workspace);
    return workspace;
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
      items: next.items.map(({ linkStates: _, ...item }) => item),
    });
  });
  const apply = (current: Workspace, changes: ThreadListUpdateInput["changes"], now: string) => {
    const items = [...current.items];
    for (const change of changes) {
      const index = change.id === undefined ? -1 : items.findIndex((item) => item.id === change.id);
      const old = items[index];
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
      if (index < 0) items.push(item);
      else items[index] = item;
    }
    return items;
  };
  // The orchestrator dedupes a command id, so a retry after a failed save with the same key
  // replays the send instead of posting a second message.
  const sendAnswers = Effect.fn("ThreadWorkspace.sendAnswers")(function* (
    current: Workspace,
    records: ReadonlyArray<ArtifactAnswerContextRecord>,
    source: "artifact" | "questions",
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
        commandId: CommandId.make(
          `${source === "artifact" ? "artifact" : "questions"}-submit:${key}`,
        ),
        messageId: MessageId.make(`${source}:${key}`),
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
    const next = yield* commit(current, { ...current, questions }, current.revision);
    yield* syncQuestions(mirroredQuestions(current), next);
    return next;
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
    }),
  });
  const storedWorkspaces = Effect.fn("ThreadWorkspace.storedWorkspaces")(function* (
    unreadable: "fail" | "skip" = "fail",
  ) {
    const files = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
      Effect.mapError(storage),
    );
    const stored: Array<{ readonly threadId: ThreadId; readonly hasQuestions: boolean }> = [];
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
      stored.push({
        threadId: value.workspace.threadId,
        hasQuestions: (value.workspace.questions?.length ?? 0) > 0,
      });
    }
    return stored;
  });
  const get = Effect.fn("ThreadWorkspace.get")(function* (input: ThreadWorkspaceGetInput) {
    return yield* enrich(yield* read(input.threadId));
  }, lock.withPermit);
  return ThreadWorkspace.of({
    get,
    update: Effect.fn("ThreadWorkspace.update")(function* (input) {
      const current = yield* read(input.threadId);
      let items = apply(current, input.changes, DateTime.formatIso(yield* DateTime.now));
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
      return yield* commit(
        current,
        {
          ...current,
          items,
          summaryNotes: input.summaryNotes ?? current.summaryNotes,
          childPreamble: input.childPreamble ?? current.childPreamble,
        },
        input.expectedRevision,
      );
    }, lock.withPermit),
    rewrite: Effect.fn("ThreadWorkspace.rewrite")(function* (input) {
      const current = yield* read(input.threadId);
      const retained = current.items.filter((item) => item.state !== "open");
      if (
        input.items.some(
          (change) => change.id !== undefined && retained.some((item) => item.id === change.id),
        )
      )
        return yield* invalid("Rewrite cannot change finished or handed-off history.");
      const replacements = apply(
        { ...current, items: [] },
        input.items,
        DateTime.formatIso(yield* DateTime.now),
      );
      const survivingIds = new Set([...retained, ...replacements].map((item) => item.id));
      const history = retained.map((item) => {
        let parentId = item.parentId;
        while (parentId !== null && !survivingIds.has(parentId))
          parentId = current.items.find((entry) => entry.id === parentId)?.parentId ?? null;
        return parentId === item.parentId ? item : { ...item, parentId };
      });
      return yield* commit(
        current,
        { ...current, items: [...history, ...replacements] },
        input.expectedRevision,
      );
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
      yield* sendAnswers(current, records, "artifact", String(current.revision));
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
          questions[index] = { ...old, state: "replaced", closedAt: now, replacedBy: question.id };
        }
        questions.push(question);
      }
      return yield* commitQuestions(current, questions);
    }, lock.withPermit),
    questionUpdate: Effect.fn("ThreadWorkspace.questionUpdate")(function* (input, by) {
      const current = yield* read(input.threadId);
      const { index, question } = yield* findQuestion(current, input.id);
      const now = DateTime.formatIso(yield* DateTime.now);
      let next: ThreadQuestion;
      switch (input.state) {
        case "open":
          if (question.state === "open") return yield* invalid(`${question.id} is already open.`);
          next = {
            ...question,
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
          if (by === "user") return yield* invalid("Submit answers so the agent receives them.");
          const chosenOptionIds = input.answer?.chosenOptionIds ?? [];
          const notes = input.answer?.notes ?? "";
          if (!chosenOptionIds.length && !notes.trim())
            return yield* invalid(`Record the answer to ${question.id} as you understood it.`);
          if (!artifactAnswerFits(question, chosenOptionIds))
            return yield* invalid(`Answer choices must be options of ${question.id}.`);
          next = {
            ...question,
            state: "answered",
            closedAt: now,
            answeredBy: "agent",
            answer: { chosenOptionIds, notes, submittedAt: now },
          };
          break;
        }
      }
      const { userChangedAt: _reported, ...changed } = next;
      const questions = [...current.questions];
      questions[index] = by === "user" ? { ...changed, userChangedAt: now } : changed;
      return yield* commitQuestions(current, questions);
    }, lock.withPermit),
    questionDraft: Effect.fn("ThreadWorkspace.questionDraft")(function* (input) {
      const current = yield* read(input.threadId);
      const questions = [...current.questions];
      for (const [id, answer] of Object.entries(input.answers)) {
        const { index, question } = yield* findQuestion(current, id);
        if (!isWaiting(question))
          return yield* invalid(`${id} is ${question.state}; reopen it to answer.`);
        if (!artifactAnswerFits(question, answer.chosenOptionIds))
          return yield* invalid(`Answer choices must be options of ${id}.`);
        questions[index] = {
          ...question,
          answer: { ...answer, submittedAt: null, draftRevision: current.revision + 1 },
        };
      }
      return yield* commitQuestions(current, questions);
    }, lock.withPermit),
    questionSubmit: Effect.fn("ThreadWorkspace.questionSubmit")(function* (input) {
      const current = yield* read(input.threadId);
      if (new Set(input.ids).size !== input.ids.length)
        return yield* invalid("Choose each question once.");
      for (const id of input.ids) yield* findQuestion(current, id);
      // Workspace order, not argument order, so a retry in any order sends the same message.
      const chosen = current.questions.filter((question) => input.ids.includes(question.id));
      const records: ArtifactAnswerContextRecord[] = [];
      for (const question of chosen) {
        const id = question.id;
        const answer = question.answer;
        if (!isWaiting(question)) return yield* invalid(`${id} is already ${question.state}.`);
        if (!answer || (!answer.chosenOptionIds.length && !answer.notes.trim()))
          return yield* invalid(`Choose an answer or add a note to ${id} before sending.`);
        const title = `${question.id}: ${threadQuestionTitle(question.prompt)}`;
        const key = NodeCrypto.createHash("sha256")
          .update(
            yield* encodeSnapshot([input.threadId, question, answer]).pipe(
              Effect.mapError(storage),
            ),
          )
          .digest("hex");
        records.push({
          contextId: ComposerContextId.make(`answer_${key}`),
          kind: "artifact-answer",
          label: sanitizeComposerContextLabel(title, "artifact-answer"),
          artifactId: THREAD_QUESTIONS_ARTIFACT_ID,
          questionId: question.id,
          answerRevision: answer.draftRevision ?? 0,
          title: title.slice(0, 200),
          version: 1,
          artifactVersion: 1,
          question: question.prompt,
          choice: choiceLabels(question, answer.chosenOptionIds),
          note: answer.notes,
        });
      }
      // Keyed by the thread and answers, not the revision, so a retry after a failed save
      // replays this send even when an unrelated edit landed in between.
      yield* sendAnswers(current, records, "questions", "questions");
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* commitQuestions(
        current,
        current.questions.map((question) =>
          input.ids.includes(question.id) && question.answer
            ? {
                ...question,
                state: "answered" as const,
                closedAt: now,
                answeredBy: "user" as const,
                answer: { ...question.answer, submittedAt: now },
              }
            : question,
        ),
      );
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
    reconcileQuestions: Effect.gen(function* () {
      // Questions are never deleted, so a file without any has nothing to mirror.
      const stored = (yield* storedWorkspaces("skip")).filter((entry) => entry.hasQuestions);
      // One permit per thread, so requests arriving during startup wait for one repair at most.
      for (const { threadId } of stored)
        yield* read(threadId).pipe(
          lock.withPermit,
          Effect.catch((cause) =>
            cause.code === "not_found"
              ? Effect.void
              : Effect.logWarning("Could not reconcile thread questions.", { threadId, cause }),
          ),
        );
      return stored.length;
    }).pipe(Effect.withSpan("ThreadWorkspace.reconcileQuestions")),
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
