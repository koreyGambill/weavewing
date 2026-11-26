import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { CONTEXT_REWIND_MIN_REMOVED_CHARS } from "../../../orchestration-v2/contextRewind.ts";

const minimumTokens = Math.round(CONTEXT_REWIND_MIN_REMOVED_CHARS / 4).toLocaleString("en-US");

// Listed only to sessions holding the `context-rewind` capability; McpHttpServer applies the gate
// and ends the provider turn after a successful call.
export const ContextRewindToolkit = Toolkit.make(
  Tool.make("context_rewind", {
    description: `Remove your most recent tool calls and their raw results from your context and replace them with a summary you write. Every later step re-reads your whole context, so call this straight after lookups (searches, fetches, large listings or file reads) whose raw output you no longer need, before doing other work, when work remains. It is refused when the removed results total under about ${minimumTokens} tokens. The summary is all you will remember: keep every fact you still need, with URLs, identifiers and file paths. Your turn ends at this call and continues from your summary.`,
    parameters: Schema.Struct({
      summary: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "What you learned from the tool calls being removed.",
      }),
      tool_calls: Schema.optional(
        Schema.Int.check(Schema.isGreaterThan(0)).annotate({
          description:
            "How many of your most recent tool calls to remove, counting back from this one (not counting this call). Omit to remove every tool call since the user's last message.",
        }),
      ),
    }),
    success: Schema.Struct({ removedToolCalls: Schema.Number, next: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
  })
    .annotate(Tool.Title, "Rewind your context to a summary")
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
    // A deferred tool is never loaded for a cost the agent does not see, so Claude gets it up front.
    .annotate(Tool.Meta, { "anthropic/alwaysLoad": true }),
);

export const CONTEXT_REWIND_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(ContextRewindToolkit.tools),
);

// The provider removes its whole turn, so this variant takes no count and its summary must also
// record what the turn already did. Listed only to sessions holding `context-rewind-turn`.
export const ContextRewindTurnToolkit = Toolkit.make(
  Tool.make("context_rewind_turn", {
    description: `Replace everything you did since the user's last message, your tool calls and their raw results included, with a summary you write. Every later step re-reads your whole context, so call this straight after lookups (searches, fetches, large listings or file reads) whose raw output you no longer need, before doing other work, when work remains. It is refused when the removed results total under about ${minimumTokens} tokens. The summary is all you will remember of this turn: keep every fact you still need, with URLs, identifiers and file paths, and say what you already did, such as files you changed and commands you ran, because their effects remain. Your turn ends at this call and continues from the user's message and your summary.`,
    parameters: Schema.Struct({
      summary: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "What you learned and what you did since the user's last message.",
      }),
    }),
    success: Schema.Struct({ removedToolCalls: Schema.Number, next: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
  })
    .annotate(Tool.Title, "Rewind your turn to a summary")
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);

export const CONTEXT_REWIND_TURN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(ContextRewindTurnToolkit.tools),
);
