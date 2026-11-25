import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { ContextRewindToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ContextRewindToolkit, {
  context_rewind: McpToolAccess.actsAsCaller(({ summary, tool_calls }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "context_rewind");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { removedToolCalls } = yield* threads
        .rewindContext({ threadId: caller.thread.threadId, summary, toolCalls: tool_calls })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code: cause.reason === "failed" ? "orchestration_error" : "invalid_request",
                message: cause.message,
              }),
          ),
        );
      return {
        removedToolCalls,
        next: "End your turn now. Your next turn starts from your summary.",
      };
    }),
  ),
});
