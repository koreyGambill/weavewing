// Runs the agent on the local Claude CLI login instead of the API. Eval-only Node plumbing.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type Block = { readonly type: string; readonly [key: string]: unknown };
type Message = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type Json = Readonly<Record<string, unknown>>;
export type StubTool = {
  readonly name: string;
  readonly description?: unknown;
  readonly input_schema?: unknown;
  readonly alwaysLoad?: boolean;
};
export type StubAnswer = { readonly text: string; readonly isError: boolean };
export type StubCall = (name: string, input: unknown, toolUseId: string) => Promise<StubAnswer>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One JSON-RPC reply from a stub MCP server; undefined for a notification. */
export const mcpReply = async (request: Json, tools: ReadonlyArray<StubTool>, call: StubCall) => {
  if (request.id === undefined) return undefined;
  const params = isRecord(request.params) ? request.params : {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === "initialize") {
    const protocolVersion = params.protocolVersion ?? "2025-06-18";
    const serverInfo = { name: "mcp-tool-use-eval", version: "0" };
    return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo });
  }
  if (request.method === "tools/list") {
    return ok({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        ...(tool.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
      })),
    });
  }
  if (request.method === "tools/call") {
    const meta = isRecord(params._meta) ? params._meta : {};
    const id = meta["claudecode/toolUseId"];
    const answer = await call(
      String(params.name),
      params.arguments ?? {},
      typeof id === "string" ? id : `stub_${NodeCrypto.randomUUID()}`,
    );
    return ok({ content: [{ type: "text", text: answer.text }], isError: answer.isError });
  }
  return ok({});
};

/** Serves stub MCP servers over streamable HTTP on localhost, one per path segment. */
export const serveStubs = async (
  servers: Readonly<Record<string, { readonly tools: ReadonlyArray<StubTool>; call: StubCall }>>,
) => {
  const http = NodeHttp.createServer((request, response) => {
    const server = servers[(request.url ?? "").slice(1)];
    if (request.method !== "POST" || server === undefined) return response.writeHead(405).end();
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      void mcpReply(JSON.parse(body) as Json, server.tools, server.call).then(
        (reply) =>
          reply === undefined
            ? response.writeHead(202).end()
            : response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify(reply)),
        (error: unknown) => response.writeHead(500).end(String(error)),
      );
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { readonly port: number };
  const mcpServers = Object.fromEntries(
    Object.keys(servers).map((name) => [
      name,
      { type: "http", url: `http://127.0.0.1:${port}/${name}` },
    ]),
  );
  return { mcpConfig: JSON.stringify({ mcpServers }), close: () => http.close() };
};

const projectsDir = (cwd: string) =>
  NodePath.join(
    process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
  );

/**
 * A scratch cwd and, when the case has earlier turns, a session file holding them so `--resume`
 * replays real tool blocks. `cleanup` removes both, plus the CLI's own folder for that cwd.
 */
export const prepareSession = (history: ReadonlyArray<Message>, model: string) => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-tool-use-"));
  const dir = projectsDir(cwd);
  const cleanup = () => {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
    NodeFS.rmSync(dir, { recursive: true, force: true });
  };
  if (history.length === 0) return { cwd, cleanup };
  const sessionId = NodeCrypto.randomUUID();
  let parentUuid: string | null = null;
  const lines = history.map(({ role, content }) => {
    const uuid = NodeCrypto.randomUUID();
    const message =
      role === "user"
        ? { role, content }
        : { role, content, id: `msg_${uuid}`, type: "message", model, stop_reason: "tool_use" };
    const line = { type: role, message, uuid, parentUuid, sessionId, cwd, isSidechain: false };
    parentUuid = uuid;
    return JSON.stringify({ ...line, userType: "external", timestamp: "2026-01-01T00:00:00.000Z" });
  });
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  return { cwd, cleanup, sessionId };
};

// No CLAUDE.md, settings, hooks, skills, or saved session from this machine reach the run.
export const ISOLATION = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];

/** Stops a run early, by request or after `ms`. */
export const stopper = (ms: number) => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]);
  return { signal, stop: () => controller.abort(), requested: () => controller.signal.aborted };
};

/** Runs `claude -p` and returns its stdout JSON lines. An abort ends it early without failing. */
export const runClaude = (
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly stdin: string; readonly signal?: AbortSignal },
) =>
  new Promise<Array<Json>>((resolve, reject) => {
    const child = NodeChildProcess.spawn("claude", ["-p", ...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      if (error.name !== "AbortError") reject(error);
    });
    child.on("close", (code) => {
      const lines = out.split("\n").flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return isRecord(value) ? [value] : [];
        } catch {
          return [];
        }
      });
      if (code === 0 || options.signal?.aborted || lines.some((line) => line.type === "result")) {
        resolve(lines);
      } else reject(new Error(`claude exited ${code}: ${err.slice(-2000)}`));
    });
    child.stdin.end(options.stdin);
  });

/** Assistant text and tool uses from stream-json events. A step is one assistant message. */
export const streamTurns = (events: ReadonlyArray<Json>) => {
  const texts: Array<string> = [];
  const uses: Array<{ readonly step: number; readonly use: Block }> = [];
  let step = -1;
  let messageId: unknown;
  for (const event of events) {
    const message = event.type === "assistant" ? event.message : undefined;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    if (step === -1 || message.id !== messageId) step++;
    messageId = message.id;
    for (const block of message.content as ReadonlyArray<Block>) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      if (block.type === "tool_use") uses.push({ step, use: block });
    }
  }
  const result = events.find((event) => event.type === "result");
  return { texts, uses, result };
};

/** Token usage and CLI-reported cost from a `result` event. */
export const resultUsage = (result: Json | undefined) => {
  const usage = isRecord(result?.usage) ? result.usage : {};
  const count = (key: string) => (typeof usage[key] === "number" ? usage[key] : 0);
  return {
    usage: {
      input_tokens: count("input_tokens"),
      output_tokens: count("output_tokens"),
      cache_creation_input_tokens: count("cache_creation_input_tokens"),
      cache_read_input_tokens: count("cache_read_input_tokens"),
    },
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0,
  };
};

// Claude Code always attaches the login's email as context; the simulated machine is not theirs.
const NO_ACCOUNT =
  "Ignore any account details or email address in the context. They are not part of the machine; wherever a name or email is needed, use 'Example User <user@example.com>'.";

/** One structured-output call with no tools, as the shell simulator makes. */
export const claudeStructured = async (body: {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly schema: unknown;
}) => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-tool-use-shell-"));
  try {
    const args = [
      "--model",
      body.model,
      "--effort",
      "low",
      "--output-format",
      "json",
      "--tools",
      "",
      "--system-prompt",
      `${body.system}\n\n${NO_ACCOUNT}`,
      "--json-schema",
      JSON.stringify(body.schema),
      ...ISOLATION,
    ];
    const [result] = await runClaude(args, { cwd, stdin: body.prompt });
    const output = result?.structured_output ?? result?.result ?? "";
    const text = typeof output === "string" ? output : JSON.stringify(output);
    return { content: [{ type: "text", text }], ...resultUsage(result) };
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
    NodeFS.rmSync(projectsDir(cwd), { recursive: true, force: true });
  }
};
