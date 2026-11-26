import {
  OrchestratorMcpFailure,
  type EvidenceError,
  type ThreadWorkspaceError,
  type ThreadWorkspace as WorkspaceDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ThreadWorkspace } from "../../../threadWorkspace/ThreadWorkspace.ts";
import type { ListActor } from "../../../threadWorkspace/userTasks.ts";
import * as EvidenceService from "../../../evidence/EvidenceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, readThread } from "../../threadAccess.ts";
import { ReviewToolkit } from "./tools.ts";

const failure = (error: ThreadWorkspaceError) =>
  new OrchestratorMcpFailure({
    code: error.code === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const evidenceFailure = (error: EvidenceError) =>
  new OrchestratorMcpFailure({
    code: error.code === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

// An agent settles a user task only from the user's message in its own thread's turn, so the
// message is looked up only when a change claims it.
const agentActor = Effect.fn("ReviewToolkit.agentActor")(function* (
  changes: ReadonlyArray<{ readonly settledFromUser?: boolean | undefined }>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const evidence = yield* EvidenceService.EvidenceService;
  const userMessageId =
    scope.thread === undefined || !changes.some((change) => change.settledFromUser === true)
      ? null
      : yield* evidence
          .turnUserMessage(scope.thread.threadId)
          .pipe(Effect.mapError(evidenceFailure));
  return { by: "agent", userMessageId } satisfies ListActor;
});

const listResult = (
  workspace: WorkspaceDocument,
  changes: ReadonlyArray<{ readonly id?: string | undefined }>,
  before?: WorkspaceDocument,
) => {
  const requested = new Set(changes.flatMap((item) => (item.id ? [item.id] : [])));
  const existing = before && new Set(before.items.map((item) => item.id));
  // Creating a task for the user, or handing an item to the user, files it.
  const filedTasks = workspace.items.flatMap((item) =>
    item.owner === "you" &&
    item.ref !== undefined &&
    before !== undefined &&
    before.items.find((entry) => entry.id === item.id)?.owner !== "you"
      ? [item.ref]
      : [],
  );
  return {
    ...(filedTasks.length === 0 ? {} : { filedTasks }),
    revision: workspace.revision,
    items: workspace.items
      .filter(
        (item) =>
          requested.has(item.id) ||
          (item.ref !== undefined && requested.has(item.ref)) ||
          (existing && !existing.has(item.id)),
      )
      .map(({ id, text, state, owner, links, doneAt, ref }) => ({
        id,
        text,
        state,
        owner,
        links,
        doneAt,
        ...(ref === undefined ? {} : { ref }),
      })),
  };
};

export const layer = McpToolAccess.toLayer(ReviewToolkit, {
  list_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workspace = yield* ThreadWorkspace;
      if (input.allThreads) {
        yield* readCaller();
        const entries = yield* workspace.listRead(input).pipe(Effect.mapError(failure));
        yield* Effect.forEach(entries, (entry) => readThread(entry.threadId));
        return entries;
      }
      const { projection } = yield* readThread(input.threadId);
      return yield* workspace
        .listRead({ ...input, threadId: projection.thread.id })
        .pipe(Effect.mapError(failure));
    }),
  ),
  list_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const workspace = yield* ThreadWorkspace;
        const before = input.changes.some((item) => item.id === undefined || item.owner === "you")
          ? yield* workspace.get({ threadId: projection.thread.id }).pipe(Effect.mapError(failure))
          : undefined;
        const actor = yield* agentActor(input.changes);
        return yield* workspace.update({ ...input, threadId: projection.thread.id }, actor).pipe(
          Effect.map((result) => listResult(result, input.changes, before)),
          Effect.mapError(failure),
        );
      }),
  ),
  list_rewrite: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const workspace = yield* ThreadWorkspace;
        const before = input.items.some((item) => item.id === undefined || item.owner === "you")
          ? yield* workspace.get({ threadId: projection.thread.id }).pipe(Effect.mapError(failure))
          : undefined;
        const actor = yield* agentActor(input.items);
        return yield* workspace.rewrite({ ...input, threadId: projection.thread.id }, actor).pipe(
          Effect.map((result) => listResult(result, input.items, before)),
          Effect.mapError(failure),
        );
      }),
  ),
  artifact_write: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const workspace = yield* ThreadWorkspace;
        const result = yield* workspace
          .artifactWrite({ ...input, threadId: projection.thread.id })
          .pipe(Effect.mapError(failure));
        const artifact = result.artifacts.at(-1)!;
        const version = artifact.versions.at(-1)!;
        return {
          threadId: result.threadId,
          revision: result.revision,
          id: artifact.id,
          title: version.title,
          format: version.format,
          version: version.version,
          createdAt: version.createdAt,
          unansweredQuestions: version.questions.filter(
            (question) => !version.answers[question.id]?.submittedAt,
          ).length,
        };
      }),
  ),
  artifact_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const workspace = yield* ThreadWorkspace;
      return yield* workspace
        .artifactRead({ ...input, threadId: projection.thread.id })
        .pipe(Effect.mapError(failure));
    }),
  ),
  artifact_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const workspace = yield* ThreadWorkspace;
      return yield* workspace
        .artifactList({ threadId: projection.thread.id })
        .pipe(Effect.mapError(failure));
    }),
  ),
  evidence_record: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const thread = projection.thread;
        const evidence = yield* EvidenceService.EvidenceService;
        return yield* evidence
          .record({
            ...input,
            threadId: thread.id,
            projectId: thread.projectId,
          })
          .pipe(Effect.mapError(evidenceFailure));
      }),
  ),
  evidence_qa_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "Evidence QA",
      );
      const evidence = yield* EvidenceService.EvidenceService;
      return yield* evidence
        .agentSetQa({ ...input, threadId: scope.thread.threadId })
        .pipe(Effect.mapError(evidenceFailure));
    }),
  ),
  evidence_read: McpToolAccess.reads(({ landingId, ...input }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const evidence = yield* EvidenceService.EvidenceService;
      if (landingId !== undefined)
        return yield* evidence.get({ landingId }).pipe(Effect.mapError(evidenceFailure));
      return yield* evidence.list(input).pipe(Effect.mapError(evidenceFailure));
    }),
  ),
});
