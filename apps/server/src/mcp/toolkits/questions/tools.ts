import {
  OrchestratorMcpFailure,
  ThreadQuestionAskInput,
  ThreadQuestionUpdateInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { ThreadWorkspace } from "../../../threadWorkspace/ThreadWorkspace.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ThreadWorkspace,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};

// Listed only to sessions holding the `questions` capability; McpHttpServer applies the gate.
export const QuestionToolkit = Toolkit.make(
  Tool.make("question_ask", {
    ...common,
    description:
      "Ask the user for decisions that are theirs to make, including ones you work around with a default for now. Your turn continues. Returns ids (Q1, ...). `replaces` supersedes one of your open questions.",
    parameters: Schema.Struct({ questions: ThreadQuestionAskInput.fields.questions }),
    success: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
    // A deferred tool goes unused when its decision can wait, so Claude gets these up front.
    .annotate(Tool.Meta, { "anthropic/alwaysLoad": true }),
  Tool.make("question_update", {
    ...common,
    description:
      "Change one of your questions: `answered` with the answer as you understood it, `withdrawn` when it no longer matters, `deferred`, or `open` to reopen.",
    parameters: Schema.Struct({
      id: ThreadQuestionUpdateInput.fields.id,
      state: ThreadQuestionUpdateInput.fields.state,
      answer: ThreadQuestionUpdateInput.fields.answer,
    }),
    success: Schema.Struct({ id: Schema.String, state: Schema.String }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
    // A deferred tool goes unused when its decision can wait, so Claude gets these up front.
    .annotate(Tool.Meta, { "anthropic/alwaysLoad": true }),
);

export const QUESTION_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(QuestionToolkit.tools));
