import {
  clampedPositiveInt,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  TerminalObserveInput,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Terminal from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([McpCapabilityUnavailableError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, Terminal.TerminalManager],
};
const terminalId = TerminalObserveInput.fields.terminalId;
const usage = "Use only when the user asks you to work in their terminal.";

const TerminalListTool = Tool.make("terminal_list", {
  ...shared,
  description: `List the terminals in this thread. ${usage}`,
  success: Schema.Struct({
    terminals: Schema.Array(
      Schema.Struct({
        terminalId,
        status: TerminalSessionStatus,
        cwd: Schema.String,
        hasRunningSubprocess: Schema.Boolean,
        childCommand: Schema.NullOr(Schema.String),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const TerminalReadTool = Tool.make("terminal_read", {
  ...shared,
  description: `Read recent plain-text output from a terminal listed by terminal_list. ${usage}`,
  parameters: Schema.Struct({
    terminalId,
    lines: Schema.optional(clampedPositiveInt(Terminal.MAX_TERMINAL_READ_LINES)),
  }),
  success: Schema.Struct({ text: Schema.String, truncated: Schema.Boolean }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const TerminalSendTool = Tool.make("terminal_send", {
  ...shared,
  description: `Type into a running terminal listed by terminal_list. Presses Enter by default. ${usage}`,
  dependencies: [...shared.dependencies, ThreadManagement.ThreadManagementService],
  parameters: Schema.Struct({
    terminalId,
    text: TerminalWriteInput.fields.data,
    enter: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({}),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const TerminalToolkit = Toolkit.make(TerminalListTool, TerminalReadTool, TerminalSendTool);
