import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Claude Code built-in tools a user may leave out of the sessions T3 starts. ToolSearch and Skill
 * are never offered: removing either loads more context than it saves. `description` says what the
 * tool lets Claude do. `estimatedTokens` is a measured estimate of the context each tool adds, not
 * an exact figure.
 */
export const CLAUDE_REMOVABLE_BUILTIN_TOOLS = [
  {
    value: "Artifact",
    estimatedTokens: 12_900,
    label: "Artifact",
    description: "Publish claude.ai artifact pages",
  },
  {
    value: "ArtifactData",
    estimatedTokens: 500,
    label: "ArtifactData",
    description: "Read and write a published artifact's shared database",
  },
  {
    value: "ArtifactComments",
    estimatedTokens: 70,
    label: "ArtifactComments",
    description: "Read and answer comments on published artifacts",
  },
  {
    value: "Task",
    estimatedTokens: 3_300,
    label: "Task (Agent)",
    description: "Run Claude's own subagents",
  },
  {
    value: "Workflow",
    estimatedTokens: 2_100,
    label: "Workflow",
    description: "Run scripted multi-agent workflows",
  },
  {
    value: "ScheduleWakeup",
    estimatedTokens: 1_700,
    label: "ScheduleWakeup",
    description: "Let Claude wake itself later",
  },
  {
    value: "ReportFindings",
    estimatedTokens: 900,
    label: "ReportFindings",
    description: "Report review findings as a typed list",
  },
] as const satisfies ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly estimatedTokens: number;
}>;

export const ClaudeRemovableBuiltinTool = Schema.Literals(
  CLAUDE_REMOVABLE_BUILTIN_TOOLS.map((tool) => tool.value),
);
export type ClaudeRemovableBuiltinTool = typeof ClaudeRemovableBuiltinTool.Type;

/** Estimated context the claude.ai connectors add as a whole; individual connectors are unmeasured. */
export const CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS = 3_200;

/** A thread's claude.ai connectors: the provider's default, or on or off for this thread. */
export const ThreadClaudeAiConnectors = Schema.Literals(["default", "on", "off"]);
export type ThreadClaudeAiConnectors = typeof ThreadClaudeAiConnectors.Type;

// Earlier builds stored a boolean: true forced the connectors on, and false meant nothing was
// forced, so it reads as the default. New writes are always one of the strings.
const ThreadClaudeAiConnectorsField = Schema.Union([Schema.Boolean, ThreadClaudeAiConnectors]).pipe(
  Schema.decodeTo(
    ThreadClaudeAiConnectors,
    SchemaTransformation.transform<ThreadClaudeAiConnectors, boolean | ThreadClaudeAiConnectors>({
      decode: (value) => (value === true ? "on" : value === false ? "default" : value),
      encode: (value) => value,
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed("default" as const)),
);

/**
 * What one Claude thread changes about its provider's tool defaults. `enabledBuiltinTools`
 * switches on built-in tools the provider leaves out, `claudeAiConnectors` follows or overrides
 * the provider's connectors default, and `omittedMcpServers` names MCP servers left out of this
 * thread only. An absent field on a thread means no override.
 */
export const ThreadToolOverrides = Schema.Struct({
  enabledBuiltinTools: Schema.Array(ClaudeRemovableBuiltinTool),
  claudeAiConnectors: ThreadClaudeAiConnectorsField,
  omittedMcpServers: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ThreadToolOverrides = typeof ThreadToolOverrides.Type;

/** The MCP server that carries a thread's T3 tools; a thread can never leave it out. */
export const T3_MCP_SERVER_NAME = "t3-code";

/** An MCP server a Claude thread's session can load, as Claude Code reports it. */
export const ThreadMcpServer = Schema.Struct({
  name: Schema.String,
  /** A claude.ai connector, switched on and off as a group by the thread's connectors setting. */
  connector: Schema.Boolean,
  /** Claude Code's connection status, such as connected, pending or needs-auth. */
  status: Schema.String,
  /** Loaded by the thread's live session; false when only a probe found it. */
  active: Schema.Boolean,
});
export type ThreadMcpServer = typeof ThreadMcpServer.Type;

function listInProse(items: ReadonlyArray<string>): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What a saved tool change says in the timeline and the toast, e.g. "Tools changed: ScheduleWakeup on. …" */
export function threadToolOverridesNotice(overrides: ThreadToolOverrides): string {
  const switchedOn = [
    ...CLAUDE_REMOVABLE_BUILTIN_TOOLS.filter((tool) =>
      overrides.enabledBuiltinTools.includes(tool.value),
    ).map((tool) => tool.label),
    ...(overrides.claudeAiConnectors === "on" ? ["claude.ai connectors"] : []),
  ];
  const omitted = overrides.omittedMcpServers.length;
  const changes = [
    ...(switchedOn.length === 0 ? [] : [`${listInProse(switchedOn)} on`]),
    ...(overrides.claudeAiConnectors === "off" ? ["claude.ai connectors off"] : []),
    ...(omitted === 0 ? [] : [`${omitted} MCP ${omitted === 1 ? "server" : "servers"} off`]),
  ];
  const summary = changes.length === 0 ? "the provider's defaults" : changes.join(", ");
  return `Tools changed: ${summary}. This applies from the next message.`;
}
