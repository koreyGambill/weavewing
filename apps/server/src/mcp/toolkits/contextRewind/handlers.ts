import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { ContextRewindToolkit, ContextRewindTurnToolkit } from "./tools.ts";

const rewindCallerContext = Effect.fn("ContextRewindHandlers.rewindCallerContext")(function* (
  tool: string,
  input: {
    readonly summary: string;
    readonly toolCalls?: number | undefined;
    readonly wholeTurn?: boolean;
  },
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, tool);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { removedToolCalls } = yield* threads
    .rewindContext({
      threadId: caller.thread.threadId,
      summary: input.summary,
      toolCalls: input.toolCalls,
      wholeTurn: input.wholeTurn,
    })
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
});

export const layer = McpToolAccess.toLayer(ContextRewindToolkit, {
  context_rewind: McpToolAccess.actsAsCaller(({ summary, tool_calls }) =>
    rewindCallerContext("context_rewind", { summary, toolCalls: tool_calls }),
  ),
});

export const turnLayer = McpToolAccess.toLayer(ContextRewindTurnToolkit, {
  context_rewind_turn: McpToolAccess.actsAsCaller(({ summary }) =>
    rewindCallerContext("context_rewind_turn", { summary, wholeTurn: true }),
  ),
});
