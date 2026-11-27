import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";
import {
  CONTEXT_REWIND_TOOL_NAMES,
  CONTEXT_REWIND_TURN_TOOL_NAMES,
} from "../contextRewind/tools.ts";
import { QUESTION_TOOL_NAMES } from "../questions/tools.ts";
import { ToolSearchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ToolSearchToolkit, {
  tool_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const { thread, capabilities } = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "tool_search")),
      );
      const exposure = yield* McpToolExposure.McpToolExposure;
      return {
        tools: yield* exposure.search(
          thread.providerSessionId,
          query,
          new Set([
            ...(capabilities.has("questions") ? [] : [...QUESTION_TOOL_NAMES, "answer_give"]),
            ...(capabilities.has("context-rewind") ? [] : CONTEXT_REWIND_TOOL_NAMES),
            ...(capabilities.has("context-rewind-turn") ? [] : CONTEXT_REWIND_TURN_TOOL_NAMES),
          ]),
        ),
      };
    }),
  ),
});
