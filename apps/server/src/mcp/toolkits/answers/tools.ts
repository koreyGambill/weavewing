import {
  OrchestratorMcpFailure,
  TrackedAnswerMore,
  TrackedAnswerText,
  TrackedAskId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ThreadWorkspace } from "../../../threadWorkspace/ThreadWorkspace.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const AnswerToolkit = Toolkit.make(
  Tool.make("answer_give", {
    description:
      "Answer a question the user tracked (A1, ...) once you know the answer. The user sees this call as the answer's card and closes it themselves. Not for untracked questions, guesses or plans. Still reply as usual. Answering again replaces your earlier answer.",
    parameters: Schema.Struct({
      id: TrackedAskId.annotate({ description: "The tracked question, such as A3." }),
      answer: TrackedAnswerText.annotate({
        description: "Markdown. The answer itself first. At most 4000 characters.",
      }),
      more: Schema.optional(
        TrackedAnswerMore.annotate({
          description:
            "Where the fuller answer lives: an artifact id, an absolute file path, a URL or a thread link.",
        }),
      ),
    }),
    success: Schema.Struct({
      id: TrackedAskId,
      answer: Schema.Int,
      state: Schema.Literal("answered"),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      ThreadWorkspace,
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
    .annotate(Tool.Meta, { "anthropic/alwaysLoad": true }),
);
