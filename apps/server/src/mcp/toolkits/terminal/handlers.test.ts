import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DROPDOWN_TERMINAL_THREAD_ID,
  EnvironmentId,
  ProviderInstanceId,
  TERMINAL_WRITE_MAX_LENGTH,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as Terminal from "../../../terminal/Manager.ts";
import * as NodePtyAdapter from "../../../terminal/NodePtyAdapter.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("terminal-thread");
const terminalId = "thread-shell";
const invocation: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("terminal-environment"),
  requestNamespace: "terminal-session",
  thread: {
    threadId,
    providerSessionId: "terminal-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["terminal"]),
  issuedAt: 0,
};
const clientInfo = { name: "terminal-test", version: "1.0.0" };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo,
  protocolVersion: "2025-06-18",
  initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
  getClient: Effect.die("unused"),
});
const layerRuntime = Layer.merge(
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function toolFailure(result: McpSchema.CallToolResult) {
  expect(result.isError).toBe(true);
  const content = result.content[0];
  return decodeJson(content?.type === "text" ? content.text : undefined);
}

function fakeProcess(pid: number) {
  const writes: Array<string | Buffer> = [];
  const exits = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  const data = new Set<(text: string) => void>();
  const exit = () => exits.forEach((listener) => listener({ exitCode: 0, signal: null }));
  return {
    writes,
    exit,
    output: (text: string) => data.forEach((listener) => listener(text)),
    process: {
      pid,
      write: (text) => {
        writes.push(text);
      },
      kill: exit,
      resize: () => {},
      onData: (listener) => {
        data.add(listener);
        return () => {
          data.delete(listener);
        };
      },
      onExit: (listener) => {
        exits.add(listener);
        return () => {
          exits.delete(listener);
        };
      },
    } satisfies PtyAdapter.PtyProcess,
  };
}

const makeFixture = Effect.fn("TerminalToolkitTest.makeFixture")(function* (
  realAdapter?: PtyAdapter.PtyAdapter["Service"],
  modes?: Parameters<typeof McpToolAccessTestkit.liveThreadShell>[1],
) {
  const processes: Array<ReturnType<typeof fakeProcess>> = [];
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "terminal-mcp-",
  });
  const manager = yield* Terminal.makeWithOptions({
    logsDir: cwd,
    env: platform === "win32" ? { SystemRoot: hostEnvironment.SystemRoot } : {},
    shellResolver: () => (platform === "win32" ? "cmd.exe" : "/bin/sh"),
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
    processKillGraceMs: 0,
    ptyAdapter: realAdapter ?? {
      spawn: () =>
        Effect.sync(() => {
          const fake = fakeProcess(9_000 + processes.length);
          processes.push(fake);
          return fake.process;
        }),
    },
  });
  const server = yield* McpServer.McpServer.pipe(
    Effect.provide(
      McpHttpServer.layerTerminalRegistration.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(Layer.succeed(Terminal.TerminalManager, manager)),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, modes)),
          }),
        ),
      ),
    ),
  );
  const call = (
    name: string,
    args: Record<string, unknown>,
    scope: McpInvocationContext.McpInvocationScope = invocation,
  ) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  const open = (owner = threadId, id = terminalId) =>
    manager.open({ threadId: owner, terminalId: id, cwd });
  return { manager, call, open, cwd, processes };
});

it.effect("lists the calling thread's terminal and reads and types in that session", () =>
  Effect.gen(function* () {
    const { manager, call, open, cwd, processes } = yield* makeFixture();
    yield* open();
    const output = yield* Deferred.make<void>();
    const stop = yield* manager.subscribe((event) =>
      event.type === "output"
        ? Deferred.succeed(output, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    yield* Effect.addFinalizer(() => Effect.sync(stop));
    const pty = processes[0]!;
    pty.output("ready\r\n");
    yield* Deferred.await(output);

    expect((yield* call("terminal_list", {})).structuredContent).toEqual({
      terminals: [
        { terminalId, cwd, status: "running", hasRunningSubprocess: false, childCommand: null },
      ],
    });
    expect((yield* call("terminal_read", { terminalId })).structuredContent).toEqual({
      text: "ready\n",
      truncated: false,
    });
    expect((yield* call("terminal_send", { terminalId, text: "pwd" })).isError).not.toBe(true);
    const text = "x".repeat(TERMINAL_WRITE_MAX_LENGTH);
    expect((yield* call("terminal_send", { terminalId, text, enter: false })).isError).not.toBe(
      true,
    );
    expect(toolFailure(yield* call("terminal_send", { terminalId, text }))).toMatchObject({
      message: "Leave room for Enter in the terminal write limit.",
    });
    expect(
      (yield* call("terminal_send", { terminalId, text: text + "x", enter: false }).pipe(
        Effect.flip,
      )).message,
    ).toContain(String(TERMINAL_WRITE_MAX_LENGTH));
    expect(pty.writes).toEqual(["pwd\r", text]);
  }).pipe(Effect.provide(layerRuntime)),
);

it.effect("refuses real terminals owned by another thread or the drop-down", () =>
  Effect.gen(function* () {
    const { call, open, processes } = yield* makeFixture();
    const dropdown = ThreadId.make(DROPDOWN_TERMINAL_THREAD_ID);
    yield* open(ThreadId.make("other-thread"), "other-shell");
    yield* open(dropdown, "dropdown-shell");
    expect((yield* call("terminal_list", {})).structuredContent).toEqual({ terminals: [] });
    const dropdownCaller = { ...invocation, thread: { ...invocation.thread, threadId: dropdown } };
    for (const [id, caller] of [
      ["other-shell", invocation],
      ["dropdown-shell", invocation],
      ["dropdown-shell", dropdownCaller],
    ] as const) {
      const read = yield* call("terminal_read", { terminalId: id }, caller);
      const send = yield* call("terminal_send", { terminalId: id, text: "pwd" }, caller);
      for (const result of [read, send]) {
        expect(toolFailure(result)).toMatchObject({ code: "capability_denied" });
      }
    }
    expect((yield* call("terminal_list", {}, dropdownCaller)).isError).toBe(true);
    expect(processes.flatMap((process) => process.writes)).toEqual([]);
  }).pipe(Effect.provide(layerRuntime)),
);

it.effect("refuses typing into an exited terminal", () =>
  Effect.gen(function* () {
    const { manager, call, open, processes } = yield* makeFixture();
    yield* open();
    const exited = yield* Deferred.make<void>();
    const stop = yield* manager.subscribe((event) =>
      event.type === "exited"
        ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    yield* Effect.addFinalizer(() => Effect.sync(stop));
    processes[0]!.exit();
    yield* Deferred.await(exited);
    const send = yield* call("terminal_send", { terminalId, text: "pwd" });
    expect(toolFailure(send)).toMatchObject({ message: "The terminal is not running." });
    expect(processes[0]!.writes).toEqual([]);
  }).pipe(Effect.provide(layerRuntime)),
);

it.effect.each([
  { runtimeMode: "approval-required" },
  { runtimeMode: "auto-accept-edits" },
  { runtimeMode: "auto" },
  { runtimeMode: "full-access", interactionMode: "plan" },
] as const)("refuses terminal input in restricted mode %j", (modes) =>
  Effect.gen(function* () {
    const { call, open, processes } = yield* makeFixture(undefined, modes);
    yield* open();
    const send = yield* call("terminal_send", { terminalId, text: "pwd" });
    expect(toolFailure(send)).toMatchObject({ code: "capability_denied" });
    expect((yield* call("terminal_read", { terminalId })).isError).not.toBe(true);
    expect(processes[0]!.writes).toEqual([]);
  }).pipe(Effect.provide(layerRuntime)),
);

it.effect("requires a terminal capability and hides the tools from outside clients", () =>
  Effect.gen(function* () {
    const { call } = yield* makeFixture();
    const withoutTerminal = { ...invocation, capabilities: new Set<never>() };
    const outside: McpInvocationContext.McpInvocationScope = {
      ...invocation,
      thread: undefined,
      client: { sessionId: "outside-client", label: "Outside client", access: "full-access" },
    };
    for (const [name, args] of [
      ["terminal_list", {}],
      ["terminal_read", { terminalId }],
      ["terminal_send", { terminalId, text: "pwd" }],
    ] as const) {
      const result = yield* call(name, args, withoutTerminal);
      expect(toolFailure(result)).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "terminal",
      });
      expect((yield* call(name, args, outside).pipe(Effect.flip)).message).toBe(
        `Tool '${name}' not found`,
      );
    }
  }).pipe(Effect.provide(layerRuntime)),
);

it.live("sends to a disposable NodePtyAdapter shell and reads its output through MCP", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const { manager, call, open } = yield* makeFixture(adapter);
    const output = yield* Deferred.make<void>();
    let pending = "";
    const stop = yield* manager.subscribe((event) => {
      if (
        event.type !== "output" ||
        event.threadId !== threadId ||
        event.terminalId !== terminalId
      ) {
        return Effect.void;
      }
      const lines = (pending + event.data).split("\n");
      pending = lines.pop() ?? "";
      return lines.some((line) => line.trim() === "bw3837-ok")
        ? Deferred.succeed(output, undefined).pipe(Effect.asVoid)
        : Effect.void;
    });
    yield* Effect.addFinalizer(() => Effect.sync(stop));
    const session = yield* open();
    expect(session.status, session.error).toBe("running");
    expect((yield* call("terminal_send", { terminalId, text: "echo bw3837-ok" })).isError).not.toBe(
      true,
    );
    yield* Deferred.await(output);
    expect((yield* call("terminal_read", { terminalId })).structuredContent).toEqual({
      text: expect.stringMatching(/^bw3837-ok$/m),
      truncated: false,
    });
  }).pipe(Effect.provide(NodePtyAdapter.layer.pipe(Layer.provideMerge(layerRuntime)))),
);
