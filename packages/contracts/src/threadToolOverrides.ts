import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Claude Code built-in tools a user may leave out of the sessions T3 starts. ToolSearch and Skill
 * are never offered: removing either loads more context than it saves. `estimatedTokens` is a
 * measured estimate of the context each tool adds, not an exact figure.
 */
export const CLAUDE_REMOVABLE_BUILTIN_TOOLS = [
  {
    value: "Artifact",
    estimatedTokens: 12_900,
    label: "Artifact",
    description: "Claude cannot publish claude.ai artifact pages; T3's artifact_write still works.",
  },
  {
    value: "ArtifactData",
    estimatedTokens: 500,
    label: "ArtifactData",
    description: "Claude cannot read or write a published artifact's shared database.",
  },
  {
    value: "ArtifactComments",
    estimatedTokens: 70,
    label: "ArtifactComments",
    description: "Claude cannot read or answer comments on published artifacts.",
  },
  {
    value: "Task",
    estimatedTokens: 3_300,
    label: "Task (Agent)",
    description:
      "No native subagents; skills that fan out through them must use delegate_task instead.",
  },
  {
    value: "Workflow",
    estimatedTokens: 2_100,
    label: "Workflow",
    description:
      "Claude cannot run multi-agent workflow scripts; skills that use them must delegate instead.",
  },
  {
    value: "ScheduleWakeup",
    estimatedTokens: 1_700,
    label: "ScheduleWakeup",
    description: "/loop without an interval cannot pace itself; /loop with an interval still runs.",
  },
  {
    value: "ReportFindings",
    estimatedTokens: 900,
    label: "ReportFindings",
    description: "/code-review reports its findings as text instead of a typed list.",
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

/**
 * What one Claude thread changes about its provider's tool defaults. `enabledBuiltinTools` and
 * `claudeAiConnectors` switch on what the provider leaves out; `omittedMcpServers` names MCP
 * servers left out of this thread only. An absent field on a thread means no override.
 */
export const ThreadToolOverrides = Schema.Struct({
  enabledBuiltinTools: Schema.Array(ClaudeRemovableBuiltinTool),
  claudeAiConnectors: Schema.Boolean,
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
  /** A claude.ai connector, switched on and off as a group by `claudeAiConnectors`. */
  connector: Schema.Boolean,
  /** Claude Code's connection status, such as connected, pending or needs-auth. */
  status: Schema.String,
});
export type ThreadMcpServer = typeof ThreadMcpServer.Type;
