import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ThreadWorkspace } from "../../../threadWorkspace/ThreadWorkspace.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AnswerToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(AnswerToolkit, {
  answer_give: McpToolAccess.actsAsCaller(({ id, answer, more }) =>
    Effect.gen(function* () {
      const caller = yield* McpInvocationContext.McpInvocationContext;
      const scope = yield* McpInvocationContext.requireThreadScope(caller, "Tracked answers");
      const workspace = yield* ThreadWorkspace;
      const result = yield* workspace
        .answerAsk({
          threadId: scope.thread.threadId,
          id,
          text: answer,
          ...(more === undefined ? {} : { more }),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: error.code === "storage" ? "orchestration_error" : "invalid_request",
                message: error.message,
              }),
          ),
        );
      return { id, answer: result.n, state: "answered" as const };
    }),
  ),
});
