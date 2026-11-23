import {
  isDropdownTerminalThreadId,
  OrchestratorMcpFailure,
  type TerminalError,
  TerminalWriteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Terminal from "../../../terminal/Manager.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { TerminalToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const { thread } = yield* requireThreadMcpCapability("terminal");
  if (isDropdownTerminalThreadId(thread.threadId)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "The drop-down terminal is outside the calling thread.",
    });
  }
  return { threadId: thread.threadId, manager: yield* Terminal.TerminalManager };
});

const terminalFailure = (error: TerminalError) => {
  switch (error._tag) {
    case "TerminalSessionLookupError":
      return new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "Choose a terminal from terminal_list. This terminal is outside the calling thread's available terminals.",
      });
    case "TerminalNotRunningError":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The terminal is not running.",
      });
    default:
      return unavailable();
  }
};

const decodeWrite = Schema.decodeEffect(TerminalWriteInput.fields.data);

export const layer = McpToolAccess.toLayer(TerminalToolkit, {
  terminal_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { threadId, manager } = yield* access;
      return { terminals: yield* manager.list(threadId) };
    }),
  ),
  terminal_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, manager } = yield* access;
      return yield* manager.read({ ...input, threadId }).pipe(Effect.mapError(terminalFailure));
    }),
  ),
  terminal_send: McpToolAccess.actsAsCaller(
    ({ terminalId, text, enter }) =>
      Effect.gen(function* () {
        const { threadId, manager } = yield* access;
        const data = yield* decodeWrite(enter === false ? text : `${text}\r`).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Leave room for Enter in the terminal write limit.",
              }),
          ),
        );
        yield* manager
          .writeRunning({ threadId, terminalId, data })
          .pipe(Effect.mapError(terminalFailure));
        return {};
      }),
    {
      fullAccessRequired:
        "Sending input to a terminal needs a full-access calling thread in default mode.",
    },
  ),
});
