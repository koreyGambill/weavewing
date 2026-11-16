import { assert, it } from "@effect/vitest";

import { mcpReply, type StubCall, streamTurns } from "./claude-cli.ts";

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
