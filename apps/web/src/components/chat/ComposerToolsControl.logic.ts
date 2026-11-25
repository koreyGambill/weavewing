import {
  CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS,
  CLAUDE_REMOVABLE_BUILTIN_TOOLS,
  ClaudeSettings,
  type ClaudeRemovableBuiltinTool,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadMcpServer,
  type ThreadToolOverrides,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

/** The Claude settings a thread's instance runs with, or null when the instance is not Claude. */
export function claudeSettingsForInstance(
  settings: Pick<ServerSettings, "providerInstances">,
  instanceId: ProviderInstanceId,
): ClaudeSettings | null {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  // Default instances are keyed by their driver kind and need no saved entry.
  const driver = instance?.driver ?? instanceId;
  if (driver !== "claudeAgent") return null;
  try {
    return decodeClaudeSettings(instance?.config ?? {});
  } catch {
    return decodeClaudeSettings({});
  }
}

const POPOVER_DESCRIPTIONS: Record<ClaudeRemovableBuiltinTool, string> = {
  Artifact: "Publish claude.ai artifact pages",
  ArtifactData: "A published artifact's shared database",
  ArtifactComments: "Comments on published artifacts",
  Task: "Claude's own subagents",
  Workflow: "Scripted multi-agent runs",
  ScheduleWakeup: "Let Claude wake itself later",
  ReportFindings: "Structured review findings",
};

export type ToolRowKey = ClaudeRemovableBuiltinTool | "claudeAiConnectors";

export interface ToolRow {
  readonly key: ToolRowKey;
  readonly label: string;
  readonly description: string;
  /** An estimate of the context the item adds, never an exact figure. */
  readonly estimatedTokens: number;
}

/** What the thread can switch on: every item its provider leaves out, largest first. */
export function toolRows(
  provider: Pick<ClaudeSettings, "omittedBuiltinTools" | "claudeAiConnectors">,
  overrides: ThreadToolOverrides | undefined,
): ReadonlyArray<ToolRow> {
  const rows: Array<ToolRow> = CLAUDE_REMOVABLE_BUILTIN_TOOLS.filter((tool) =>
    provider.omittedBuiltinTools.includes(tool.value),
  ).map((tool) => ({
    key: tool.value,
    label: tool.label,
    description: POPOVER_DESCRIPTIONS[tool.value],
    estimatedTokens: tool.estimatedTokens,
  }));
  if (provider.claudeAiConnectors === "off" || overrides?.claudeAiConnectors === true) {
    rows.push({
      key: "claudeAiConnectors",
      label: "claude.ai connectors",
      description: "Every connector on your Claude account, all or none",
      estimatedTokens: CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS,
    });
  }
  return rows.toSorted((left, right) => right.estimatedTokens - left.estimatedTokens);
}

export function isRowOn(row: ToolRow, overrides: ThreadToolOverrides | undefined): boolean {
  return row.key === "claudeAiConnectors"
    ? overrides?.claudeAiConnectors === true
    : (overrides?.enabledBuiltinTools.includes(row.key) ?? false);
}

export interface ToolsLabel {
  readonly hidden: boolean;
  readonly onCount: number;
  readonly offCount: number;
  /** "Tools 8 off" or "Tools 2 on · 6 off". */
  readonly text: string;
}

export function toolsLabel(
  provider: Pick<ClaudeSettings, "omittedBuiltinTools" | "claudeAiConnectors"> | null,
  overrides: ThreadToolOverrides | undefined,
): ToolsLabel {
  if (provider === null) return { hidden: true, onCount: 0, offCount: 0, text: "" };
  const rows = toolRows(provider, overrides);
  const onCount = rows.filter((row) => isRowOn(row, overrides)).length;
  // Each left-out MCP server is one more item, counted from the thread alone.
  const offCount = rows.length - onCount + (overrides?.omittedMcpServers.length ?? 0);
  return {
    hidden: rows.length === 0 && offCount === 0,
    onCount,
    offCount,
    text: onCount === 0 ? `Tools ${offCount} off` : `Tools ${onCount} on · ${offCount} off`,
  };
}

export function withRowSwitched(
  overrides: ThreadToolOverrides,
  key: ToolRowKey,
  on: boolean,
): ThreadToolOverrides {
  if (key === "claudeAiConnectors") return { ...overrides, claudeAiConnectors: on };
  const rest = overrides.enabledBuiltinTools.filter((tool) => tool !== key);
  return {
    ...overrides,
    // Keep the contract's order so equal selections compare equal.
    enabledBuiltinTools: CLAUDE_REMOVABLE_BUILTIN_TOOLS.map((tool) => tool.value).filter((tool) =>
      tool === key ? on : rest.includes(tool),
    ),
  };
}

export const EMPTY_TOOL_OVERRIDES: ThreadToolOverrides = {
  enabledBuiltinTools: [],
  claudeAiConnectors: false,
  omittedMcpServers: [],
};

function sameToolOverrides(left: ThreadToolOverrides, right: ThreadToolOverrides): boolean {
  const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
    a.length === b.length && a.every((value) => b.includes(value));
  return (
    left.claudeAiConnectors === right.claudeAiConnectors &&
    sameList(left.enabledBuiltinTools, right.enabledBuiltinTools) &&
    sameList(left.omittedMcpServers, right.omittedMcpServers)
  );
}

export type ToolsFooterState =
  | { readonly kind: "running" }
  | { readonly kind: "background" }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      readonly onCount: number;
      readonly estimatedTokens: number;
      readonly serversLeftOut: number;
    };

export function toolsFooterState(input: {
  readonly rows: ReadonlyArray<ToolRow>;
  readonly saved: ThreadToolOverrides;
  readonly staged: ThreadToolOverrides;
  readonly turnRunning: boolean;
  readonly backgroundWork: boolean;
}): ToolsFooterState {
  if (input.turnRunning) return { kind: "running" };
  if (input.backgroundWork) return { kind: "background" };
  if (sameToolOverrides(input.saved, input.staged)) return { kind: "unchanged" };
  const on = input.rows.filter((row) => isRowOn(row, input.staged));
  return {
    kind: "changed",
    onCount: on.length,
    estimatedTokens: on.reduce((sum, row) => sum + row.estimatedTokens, 0),
    serversLeftOut: input.staged.omittedMcpServers.length,
  };
}

const RUNNING_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** A held queue with no active run can still reload; only a running turn blocks it. */
export function threadTurnRunning(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && RUNNING_STATUSES.has(status);
}

export function formatTokenEstimate(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

export interface McpServerRow {
  readonly name: string;
  readonly on: boolean;
}

export interface McpServerSections {
  readonly servers: ReadonlyArray<McpServerRow>;
  /** The connectors under the master switch; empty until the inventory names them. */
  readonly connectors: ReadonlyArray<McpServerRow>;
}

/**
 * Where the master switch decides (the provider keeps connectors out, or the thread switched them
 * on), a connector is in the thread only with the master on. Otherwise Claude Code decides, and a
 * connector is in unless the thread leaves it out.
 */
export function connectorsMasterDecides(
  provider: Pick<ClaudeSettings, "claudeAiConnectors">,
  saved: ThreadToolOverrides,
): boolean {
  return provider.claudeAiConnectors === "off" || saved.claudeAiConnectors;
}

export function mcpServerSections(input: {
  readonly inventory: ReadonlyArray<ThreadMcpServer>;
  readonly provider: Pick<ClaudeSettings, "claudeAiConnectors">;
  readonly saved: ThreadToolOverrides;
  readonly staged: ThreadToolOverrides;
}): McpServerSections {
  const masterDecides = connectorsMasterDecides(input.provider, input.saved);
  const row = (server: ThreadMcpServer): McpServerRow => ({
    name: server.name,
    on:
      !input.staged.omittedMcpServers.includes(server.name) &&
      (!server.connector || !masterDecides || input.staged.claudeAiConnectors),
  });
  return {
    servers: input.inventory.filter((server) => !server.connector).map(row),
    connectors: input.inventory.filter((server) => server.connector).map(row),
  };
}

const withoutNames = (names: ReadonlyArray<string>, drop: ReadonlyArray<string>) =>
  names.filter((name) => !drop.includes(name));

/** Switching one connector on while the master is off turns the master on for it alone. */
export function withMcpServerSwitched(input: {
  readonly staged: ThreadToolOverrides;
  readonly server: ThreadMcpServer;
  readonly on: boolean;
  readonly connectorNames: ReadonlyArray<string>;
  readonly masterDecides: boolean;
}): ThreadToolOverrides {
  const { staged, server, on } = input;
  if (!on) {
    return {
      ...staged,
      omittedMcpServers: [...withoutNames(staged.omittedMcpServers, [server.name]), server.name],
    };
  }
  if (server.connector && input.masterDecides && !staged.claudeAiConnectors) {
    const others = input.connectorNames.filter((name) => name !== server.name);
    return {
      ...staged,
      claudeAiConnectors: true,
      omittedMcpServers: [
        ...withoutNames(staged.omittedMcpServers, input.connectorNames),
        ...others,
      ],
    };
  }
  return { ...staged, omittedMcpServers: withoutNames(staged.omittedMcpServers, [server.name]) };
}

/** The master switch; turning it off forgets which connectors were left out one by one. */
export function withConnectorsMaster(
  staged: ThreadToolOverrides,
  on: boolean,
  connectorNames: ReadonlyArray<string>,
): ThreadToolOverrides {
  return on
    ? { ...staged, claudeAiConnectors: true }
    : {
        ...staged,
        claudeAiConnectors: false,
        omittedMcpServers: withoutNames(staged.omittedMcpServers, connectorNames),
      };
}
