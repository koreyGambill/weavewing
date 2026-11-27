import {
  OrchestratorMcpFailure,
  type EvidenceError,
  type ThreadWorkspaceError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ThreadWorkspace, type ListWrite } from "../../../threadWorkspace/ThreadWorkspace.ts";
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

// The agent's own thread, whose turn's user message is the only one it may settle a task from.
const agentCaller = Effect.map(
  McpInvocationContext.McpInvocationContext,
  (scope) => ({ by: "agent", threadId: scope.thread?.threadId }) as const,
);

/** The items a write touched, compactly, and the user tasks it filed for their cards. */
const listResult = (write: ListWrite) => {
  const changed = new Set(write.changedIds);
  return {
    ...(write.filedTasks.length === 0 ? {} : { filedTasks: [...write.filedTasks] }),
    revision: write.workspace.revision,
    items: write.workspace.items
      .filter((item) => changed.has(item.id))
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
        return yield* workspace
          .update({ ...input, threadId: projection.thread.id }, yield* agentCaller)
          .pipe(Effect.map(listResult), Effect.mapError(failure));
      }),
  ),
  list_rewrite: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const workspace = yield* ThreadWorkspace;
        return yield* workspace
          .rewrite({ ...input, threadId: projection.thread.id }, yield* agentCaller)
          .pipe(Effect.map(listResult), Effect.mapError(failure));
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
