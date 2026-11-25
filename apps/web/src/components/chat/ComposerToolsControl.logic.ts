import {
  CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS,
  CLAUDE_REMOVABLE_BUILTIN_TOOLS,
  ClaudeSettings,
  type ClaudeRemovableBuiltinTool,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadMcpServer,
  type ThreadToolOverrides,
  type ThreadToolOverridesReload,
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

export type ToolRowKey = ClaudeRemovableBuiltinTool;

export interface ToolRow {
  readonly key: ToolRowKey;
  readonly label: string;
  readonly description: string;
  /** An estimate of the context the item adds, never an exact figure. */
  readonly estimatedTokens: number;
}

/** The built-in tools the provider leaves out, which the thread can switch on, largest first. */
export function toolRows(
  provider: Pick<ClaudeSettings, "omittedBuiltinTools">,
): ReadonlyArray<ToolRow> {
  return CLAUDE_REMOVABLE_BUILTIN_TOOLS.filter((tool) =>
    provider.omittedBuiltinTools.includes(tool.value),
  )
    .map((tool) => ({
      key: tool.value,
      label: tool.label,
      description: POPOVER_DESCRIPTIONS[tool.value],
      estimatedTokens: tool.estimatedTokens,
    }))
    .toSorted((left, right) => right.estimatedTokens - left.estimatedTokens);
}

export function isRowOn(row: ToolRow, overrides: ThreadToolOverrides | undefined): boolean {
  return overrides?.enabledBuiltinTools.includes(row.key) ?? false;
}

export interface ToolsLabel {
  readonly hidden: boolean;
  readonly onCount: number;
  readonly offCount: number;
  /** "Tools all on", "Tools 8 off" or "Tools 2 on · 6 off". */
  readonly text: string;
}

/**
 * Counts left-out built-ins, the connectors where the provider keeps them out or the thread
 * forces them on, and each MCP server the thread leaves out. Hidden only off Claude.
 */
export function toolsLabel(
  provider: Pick<ClaudeSettings, "omittedBuiltinTools" | "claudeAiConnectors"> | null,
  overrides: ThreadToolOverrides | undefined,
): ToolsLabel {
  if (provider === null) return { hidden: true, onCount: 0, offCount: 0, text: "" };
  const rows = toolRows(provider);
  const connectorsForced = overrides?.claudeAiConnectors === true;
  const connectorsCount = provider.claudeAiConnectors === "off" || connectorsForced;
  const onCount = rows.filter((row) => isRowOn(row, overrides)).length + (connectorsForced ? 1 : 0);
  const offCount =
    rows.length + (connectorsCount ? 1 : 0) - onCount + (overrides?.omittedMcpServers.length ?? 0);
  return {
    hidden: false,
    onCount,
    offCount,
    text:
      onCount === 0 && offCount === 0
        ? "Tools all on"
        : onCount === 0
          ? `Tools ${offCount} off`
          : `Tools ${onCount} on · ${offCount} off`,
  };
}

export function withRowSwitched(
  overrides: ThreadToolOverrides,
  key: ToolRowKey,
  on: boolean,
): ThreadToolOverrides {
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
  | { readonly kind: "reloading" }
  | { readonly kind: "running" }
  | { readonly kind: "background" }
  | { readonly kind: "unchanged"; readonly lastReloadFailed: boolean }
  | {
      readonly kind: "changed";
      readonly onCount: number;
      /** Undefined when a partial connector selection makes the sum unknowable. */
      readonly estimatedTokens: number | undefined;
      readonly serversLeftOut: number;
    };

export function toolsFooterState(input: {
  readonly rows: ReadonlyArray<ToolRow>;
  readonly saved: ThreadToolOverrides;
  readonly staged: ThreadToolOverrides;
  /** Connector names the inventory has found, so a partial selection is recognised. */
  readonly connectorNames: ReadonlyArray<string>;
  readonly reload: ThreadToolOverridesReload["status"] | undefined;
  readonly turnRunning: boolean;
  readonly backgroundWork: boolean;
}): ToolsFooterState {
  if (input.reload === "pending") return { kind: "reloading" };
  if (input.turnRunning) return { kind: "running" };
  if (input.backgroundWork) return { kind: "background" };
  if (sameToolOverrides(input.saved, input.staged)) {
    return { kind: "unchanged", lastReloadFailed: input.reload === "failed" };
  }
  const on = input.rows.filter((row) => isRowOn(row, input.staged));
  const connectorsOn = input.staged.claudeAiConnectors;
  // The connectors' estimate covers all of them; a partial selection has no honest sum.
  const partialConnectors =
    connectorsOn &&
    input.staged.omittedMcpServers.some((name) => input.connectorNames.includes(name));
  return {
    kind: "changed",
    onCount: on.length + (connectorsOn ? 1 : 0),
    estimatedTokens: partialConnectors
      ? undefined
      : on.reduce((sum, row) => sum + row.estimatedTokens, 0) +
        (connectorsOn ? CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS : 0),
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

/**
 * `switch`: the provider keeps connectors out, so the thread's switch decides. `inherit`: Claude
 * Code decides unless the thread forces them on, so not forcing them never reads as off.
 */
export type ConnectorsMode = "switch" | "inherit";

export function connectorsMode(
  provider: Pick<ClaudeSettings, "claudeAiConnectors">,
): ConnectorsMode {
  return provider.claudeAiConnectors === "off" ? "switch" : "inherit";
}

export interface McpServerRow {
  readonly name: string;
  /** Loaded by the live session; false when only a probe found it. */
  readonly active: boolean;
  /** Whether the row offers a switch; a connector gets one only where connectors load. */
  readonly switchable: boolean;
  readonly on: boolean;
}

export interface McpServerSections {
  readonly servers: ReadonlyArray<McpServerRow>;
  readonly connectors: ReadonlyArray<McpServerRow>;
}

export function mcpServerSections(input: {
  readonly inventory: ReadonlyArray<ThreadMcpServer>;
  readonly provider: Pick<ClaudeSettings, "claudeAiConnectors">;
  readonly staged: ThreadToolOverrides;
}): McpServerSections {
  const mode = connectorsMode(input.provider);
  const row = (server: ThreadMcpServer): McpServerRow => {
    // Connectors load when the thread forces them on, or, left to Claude Code, when it loaded them.
    const switchable =
      !server.connector || input.staged.claudeAiConnectors || (mode === "inherit" && server.active);
    return {
      name: server.name,
      active: server.active,
      switchable,
      on: switchable && !input.staged.omittedMcpServers.includes(server.name),
    };
  };
  return {
    servers: input.inventory.filter((server) => !server.connector).map(row),
    connectors: input.inventory.filter((server) => server.connector).map(row),
  };
}

export function withMcpServerSwitched(
  staged: ThreadToolOverrides,
  server: string,
  on: boolean,
): ThreadToolOverrides {
  const rest = staged.omittedMcpServers.filter((name) => name !== server);
  return { ...staged, omittedMcpServers: on ? rest : [...rest, server] };
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
        omittedMcpServers: staged.omittedMcpServers.filter(
          (name) => !connectorNames.includes(name),
        ),
      };
}
