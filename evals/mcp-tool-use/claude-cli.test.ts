// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import {
  claudeStructured,
  cliSession,
  mcpReply,
  runClaude,
  type StubCall,
  streamTurns,
} from "./claude-cli.ts";

/** A stand-in `claude` binary running `body`, in a fresh directory removed by `using`. */
const fakeCli = (body: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-claude-"));
  const command = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(
    command,
    `#!${process.execPath}\nconst fs = require("node:fs");\n${body}\n`,
    {
      mode: 0o755,
    },
  );
  return { dir, command, [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true }) };
};
const putEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tools = [
  { name: "Bash", description: "Runs a command.", input_schema: { type: "object" } },
  { name: "delegate_task", description: "Delegates.", input_schema: {}, alwaysLoad: true },
];

it("answers a tools/call with the handler's result, keyed by Claude Code's tool_use id", async () => {
  const seen: Array<unknown> = [];
  const call: StubCall = async (name, input, id) => {
    seen.push({ name, input, id });
    return { text: "Exit code 1\nno such file", isError: true };
  };
  const params = {
    name: "Bash",
    arguments: { command: "cat missing" },
    _meta: { "claudecode/toolUseId": "toolu_1" },
  };
  const reply = await mcpReply(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params },
    tools,
    call,
  );
  assert.deepStrictEqual(seen, [
    { name: "Bash", input: { command: "cat missing" }, id: "toolu_1" },
  ]);
  assert.deepStrictEqual(reply, {
    jsonrpc: "2.0",
    id: 7,
    result: { content: [{ type: "text", text: "Exit code 1\nno such file" }], isError: true },
  });
});

it("lists tools with their schemas and marks up-front tools alwaysLoad", async () => {
  const never: StubCall = () => Promise.reject(new Error("not called"));
  const reply = await mcpReply({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tools, never);
  assert.deepStrictEqual(reply?.result, {
    tools: [
      { name: "Bash", description: "Runs a command.", inputSchema: { type: "object" } },
      {
        name: "delegate_task",
        description: "Delegates.",
        inputSchema: {},
        _meta: { "anthropic/alwaysLoad": true },
      },
    ],
  });
  const note = { jsonrpc: "2.0", method: "notifications/initialized" };
  assert.strictEqual(await mcpReply(note, tools, never), undefined);
});

it("numbers steps by assistant message, so parallel tool uses share one step", () => {
  const assistant = (id: string, content: ReadonlyArray<unknown>) => ({
    type: "assistant",
    message: { id, role: "assistant", content },
  });
  const use = (id: string) => ({ type: "tool_use", id, name: "mcp__harness__Bash", input: {} });
  const result = { type: "result", subtype: "success", result: "Done." };
  const turns = streamTurns([
    { type: "system", subtype: "init" },
    assistant("msg_a", [{ type: "text", text: "Checking." }]),
    assistant("msg_a", [use("toolu_1")]),
    assistant("msg_a", [use("toolu_2")]),
    { type: "user", message: { role: "user", content: [] } },
    assistant("msg_b", [use("toolu_3"), { type: "text", text: "Done." }]),
    result,
  ]);
  assert.deepStrictEqual(
    turns.uses.map(({ step, use }) => [step, use.id]),
    [
      [0, "toolu_1"],
      [0, "toolu_2"],
      [1, "toolu_3"],
    ],
  );
  assert.deepStrictEqual(turns.texts, ["Checking.", "Done."]);
  assert.strictEqual(turns.result, result);
});

it.live("gives the CLI no API key or endpoint, so it bills the login", () => {
  const inherited = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ];
  return Effect.gen(function* () {
    using cli = fakeCli(
      `console.log(JSON.stringify({ type: "result", subtype: "success", env: Object.keys(process.env) }));`,
    );
    for (const name of inherited) putEnv(name, "synthetic");
    const run = yield* runClaude([], { cwd: cli.dir, stdin: "", command: cli.command });
    const env = run.lines[0]?.env as ReadonlyArray<string>;
    assert.deepStrictEqual(
      inherited.filter((name) => env.includes(name)),
      [],
    );
    assert.include(env, "PATH");
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const name of inherited) putEnv(name, undefined);
      }),
    ),
  );
});

it.live("kills the CLI and waits for it to exit when the run is interrupted", () =>
  Effect.gen(function* () {
    using cli = fakeCli(
      `fs.writeFileSync("pid.tmp", String(process.pid)); fs.renameSync("pid.tmp", "pid"); setInterval(() => {}, 60_000);`,
    );
    const started = new Promise<void>((resolve) => {
      const watcher = NodeFS.watch(cli.dir, (_, name) => {
        if (name !== "pid") return;
        watcher.close();
        resolve();
      });
    });
    const fiber = yield* Effect.forkChild(
      runClaude([], { cwd: cli.dir, stdin: "", command: cli.command }),
    );
    yield* Effect.promise(() => started);
    const pid = Number(NodeFS.readFileSync(NodePath.join(cli.dir, "pid"), "utf8"));
    assert.isTrue(alive(pid));
    yield* Fiber.interrupt(fiber);
    assert.isFalse(alive(pid));
  }),
);

it.live("kills descendants that hold the CLI's output open after it exits", () =>
  Effect.gen(function* () {
    const holder = `const fs = require("node:fs"); fs.writeFileSync("pid.tmp", String(process.pid)); fs.renameSync("pid.tmp", "pid"); setInterval(() => {}, 60_000);`;
    using cli = fakeCli(
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify("HOLDER")}], { stdio: ["ignore", "inherit", "inherit"] }); process.exit(0);`.replace(
        JSON.stringify("HOLDER"),
        JSON.stringify(holder),
      ),
    );
    const started = new Promise<void>((resolve) => {
      const watcher = NodeFS.watch(cli.dir, (_, name) => {
        if (name !== "pid") return;
        watcher.close();
        resolve();
      });
    });
    const fiber = yield* Effect.forkChild(
      runClaude([], { cwd: cli.dir, stdin: "", command: cli.command }),
    );
    yield* Effect.promise(() => started);
    const pid = Number(NodeFS.readFileSync(NodePath.join(cli.dir, "pid"), "utf8"));
    yield* Fiber.interrupt(fiber);
    assert.isFalse(alive(pid));
  }),
);

it.live("fails a simulator call whose CLI run errored instead of answering with empty output", () =>
  Effect.gen(function* () {
    using cli = fakeCli(
      `console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true })); process.exit(1);`,
    );
    const body = { model: "claude-haiku-5-5", system: "Play a shell.", prompt: "ls", schema: {} };
    const exit = yield* Effect.exit(claudeStructured(body, cli.command));
    assert.isTrue(Exit.isFailure(exit));
  }),
);

it.live("removes the scratch directory when writing the session fails", () => {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cli-session-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const history = [{ role: "user" as const, content: [{ type: "text", text: 1n }] }];
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(Effect.scoped(cliSession(history, "claude-sonnet-5-5")));
    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(NodeFS.readdirSync(tmp), []);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        putEnv("TMPDIR", previous);
        NodeFS.rmSync(tmp, { recursive: true });
      }),
    ),
  );
});

it("counts the tokens of a run that ended before its result, once per message", () => {
  const usage = (output: number) => ({
    input_tokens: 2,
    output_tokens: output,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
  });
  const turns = streamTurns([
    { type: "assistant", message: { id: "msg_a", content: [], usage: usage(5) } },
    { type: "assistant", message: { id: "msg_a", content: [], usage: usage(5) } },
    { type: "assistant", message: { id: "msg_b", content: [], usage: usage(7) } },
  ]);
  assert.deepStrictEqual(turns.usage, {
    input_tokens: 4,
    output_tokens: 12,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 2000,
  });
});
