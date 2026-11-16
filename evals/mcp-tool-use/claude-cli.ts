// Runs the agent on the local Claude CLI login instead of the API. Eval-only Node plumbing.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

// Every run shares one empty cwd, so Claude Code keeps a single project folder for the eval.
const cwdPath = () => NodePath.join(NodeOS.tmpdir(), "mcp-tool-use-cwd");
export const cliCwd = () => {
  NodeFS.mkdirSync(cwdPath(), { recursive: true });
  return cwdPath();
};

/**
 * `--resume` flags for a session holding the case's earlier turns, so they replay as real tool
 * blocks. The file lives in a scratch directory the scope removes.
 */
export const cliSession = Effect.fn("claudeCli.session")(function* (
  history: ReadonlyArray<Message>,
  model: string,
) {
  if (history.length === 0) return [];
  const dir = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-tool-use-"))),
    (scratch) => Effect.sync(() => NodeFS.rmSync(scratch, { recursive: true, force: true })),
  );
  const sessionId = NodeCrypto.randomUUID();
  const file = NodePath.join(dir, `${sessionId}.jsonl`);
  yield* Effect.sync(() => {
    let parentUuid: string | null = null;
    const lines = history.map(({ role, content }) => {
      const uuid = NodeCrypto.randomUUID();
      const message =
        role === "user"
          ? { role, content }
          : { role, content, id: `msg_${uuid}`, type: "message", model, stop_reason: "tool_use" };
      const line = { type: role, message, uuid, parentUuid, sessionId, isSidechain: false };
      parentUuid = uuid;
      const timestamp = "2026-01-01T00:00:00.000Z";
      return JSON.stringify({ ...line, cwd: cwdPath(), userType: "external", timestamp });
    });
    NodeFS.writeFileSync(file, `${lines.join("\n")}\n`);
  });
  return ["--resume", file, "--fork-session"];
});

// No CLAUDE.md, settings, hooks, skills, or saved session from this machine reach the run.
export const ISOLATION = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];

// `claude -p` prefers an API key or endpoint in its environment over the login.
const CREDENTIALS = /^(?:ANTHROPIC_|CLAUDE_CODE_USE_)|^AWS_BEARER_TOKEN_BEDROCK$/;
const loginEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIALS.test(name)));

export class ClaudeCliError extends Schema.TaggedError<ClaudeCliError>()("ClaudeCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `claude -p failed: ${this.detail}`;
  }
}

/** Lets a caller end a run early, for a sample that already failed for good. */
export const stopper = () => {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    stop: () => controller.abort(),
    requested: () => controller.signal.aborted,
  };
};

const jsonLines = (out: string) =>
  out.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });

/**
 * Runs `claude -p` in its own process group. A stop, the 15-minute timeout, or interrupting the
 * effect kills the group, and the effect ends only once the CLI has exited.
 */
export const runClaude = (
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly stdin: string;
    readonly command?: string;
    readonly stop?: AbortSignal;
  },
) =>
  Effect.callback<
    {
      readonly lines: ReadonlyArray<Json>;
      readonly code: number | null;
      readonly stopped: boolean;
      readonly stderr: string;
    },
    ClaudeCliError
  >((resume) => {
    const child = NodeChildProcess.spawn(options.command ?? "claude", ["-p", ...args], {
      cwd: options.cwd,
      env: loginEnv(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    let out = "";
    let err = "";
    let stopped = false;
    let closed = false;
    // Descendants can hold the pipes open after the CLI exits, so the group dies until close.
    const kill = () => {
      if (child.pid === undefined || closed) return;
      stopped = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    options.stop?.addEventListener("abort", kill);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) =>
      resume(Effect.fail(new ClaudeCliError({ detail: error.message }))),
    );
    child.on("close", (code) => {
      closed = true;
      options.stop?.removeEventListener("abort", kill);
      resume(Effect.succeed({ lines: jsonLines(out), code, stopped, stderr: err.slice(-2000) }));
    });
    child.stdin.end(options.stdin);
    return Effect.promise(() => {
      kill();
      return exited;
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 minutes",
      orElse: () => Effect.fail(new ClaudeCliError({ detail: "timed out after 15 minutes" })),
    }),
  );

const tokens = (usage: unknown) => {
  const record = isRecord(usage) ? usage : {};
  const count = (key: string) => (typeof record[key] === "number" ? record[key] : 0);
  return {
    input_tokens: count("input_tokens"),
    output_tokens: count("output_tokens"),
    cache_creation_input_tokens: count("cache_creation_input_tokens"),
    cache_read_input_tokens: count("cache_read_input_tokens"),
  };
};

/**
 * Assistant text and tool uses from stream-json events. A step is one assistant message. `usage`
 * sums each message's usage once; its output counts are a lower bound.
 */
export const streamTurns = (events: ReadonlyArray<Json>) => {
  const texts: Array<string> = [];
  const uses: Array<{ readonly step: number; readonly use: Block }> = [];
  const perMessage = new Map<unknown, ReturnType<typeof tokens>>();
  let step = -1;
  let messageId: unknown;
  for (const event of events) {
    const message = event.type === "assistant" ? event.message : undefined;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    if (step === -1 || message.id !== messageId) step++;
    messageId = message.id;
    if (message.usage !== undefined) perMessage.set(message.id, tokens(message.usage));
    for (const block of message.content as ReadonlyArray<Block>) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      if (block.type === "tool_use") uses.push({ step, use: block });
    }
  }
  const usage = tokens({});
  for (const counts of perMessage.values()) {
    for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += counts[key];
  }
  const result = events.find((event) => event.type === "result");
  return { texts, uses, result, usage };
};

/** Token usage and the cost the CLI reported in a `result` event, if it reported one. */
export const resultUsage = (result: Json) => ({
  usage: tokens(result.usage),
  costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
});

// Claude Code always attaches the login's email as context; the simulated machine is not theirs.
const NO_ACCOUNT =
  "Ignore any account details or email address in the context. They are not part of the machine; wherever a name or email is needed, use 'Example User <user@example.com>'.";

/** One structured-output call with no tools, as the shell simulator makes. Fails unless it answered. */
export const claudeStructured = Effect.fn("claudeCli.structured")(function* (
  body: {
    readonly model: string;
    readonly system: string;
    readonly prompt: string;
    readonly schema: unknown;
  },
  command?: string,
) {
  const run = yield* runClaude(structuredArgs(body.model, body.system, body.schema), {
    cwd: cliCwd(),
    stdin: body.prompt,
    ...(command === undefined ? {} : { command }),
  });
  const result = run.lines.find((line) => line.type === "result");
  if (run.code !== 0 || result?.subtype !== "success" || result.structured_output === undefined) {
    const status = valueOf(result?.subtype) ?? `exit ${run.code}`;
    return yield* new ClaudeCliError({ detail: `shell simulator ${status}: ${run.stderr}` });
  }
  const text = jsonText(result.structured_output);
  return { content: [{ type: "text", text }], ...resultUsage(result) };
});

const jsonText = (value: unknown) => JSON.stringify(value);
const structuredArgs = (model: string, system: string, schema: unknown) => [
  "--model",
  model,
  "--effort",
  "low",
  "--output-format",
  "json",
  "--tools",
  "",
  "--system-prompt",
  `${system}\n\n${NO_ACCOUNT}`,
  "--json-schema",
  jsonText(schema),
  ...ISOLATION,
];

const valueOf = (value: unknown) => (typeof value === "string" ? value : undefined);
