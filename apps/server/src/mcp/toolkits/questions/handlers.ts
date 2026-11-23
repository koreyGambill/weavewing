import { OrchestratorMcpFailure, type ThreadWorkspaceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadWorkspace } from "../../../threadWorkspace/ThreadWorkspace.ts";
import { QuestionToolkit } from "./tools.ts";

const failure = (error: ThreadWorkspaceError) =>
  new OrchestratorMcpFailure({
    code: error.code === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const callerThreadId = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "Thread questions")),
  Effect.map((scope) => scope.thread.threadId),
);

export const layer = McpToolAccess.toLayer(QuestionToolkit, {
  question_ask: McpToolAccess.actsAsCaller(({ questions }) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId;
      const workspace = yield* ThreadWorkspace;
      const result = yield* workspace
        .questionAsk({ threadId, questions })
        .pipe(Effect.mapError(failure));
      return { ids: result.questions.slice(-questions.length).map((question) => question.id) };
    }),
  ),
  question_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId;
      const workspace = yield* ThreadWorkspace;
      yield* workspace
        .questionUpdate({ ...input, threadId }, "agent")
        .pipe(Effect.mapError(failure));
      return { id: input.id, state: input.state };
    }),
  ),
});
