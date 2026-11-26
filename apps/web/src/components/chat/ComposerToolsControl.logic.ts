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
      description: tool.description,
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
  /** The text after "Tools", which the thread menu shows beside its "Tools" row. */
  readonly value: string;
}

type ConnectorsProvider = Pick<ClaudeSettings, "claudeAiConnectors">;

/** Whether the thread has the claude.ai connectors: its own setting, else the provider default. */
export function connectorsOn(
  provider: ConnectorsProvider,
  overrides: ThreadToolOverrides | undefined,
): boolean {
  const thread = overrides?.claudeAiConnectors ?? "default";
  return thread === "default" ? provider.claudeAiConnectors === "on" : thread === "on";
}

/** What switching the claude.ai connectors needs besides the staged tools. */
export interface ConnectorsGroup {
  readonly provider: ConnectorsProvider;
  /** The thread's saved tools, which switching back to their value restores exactly. */
  readonly saved: ThreadToolOverrides;
  /** The connectors the inventory names; empty until it loads. */
  readonly names: ReadonlyArray<string>;
}

// Back to the saved value keeps the saved setting, so an unsaved round trip changes nothing;
// otherwise the provider's default clears the thread's setting, so a later default reaches it.
function withConnectorsGroup(
  group: ConnectorsGroup,
  staged: ThreadToolOverrides,
  on: boolean,
): ThreadToolOverrides {
  const claudeAiConnectors =
    on === connectorsOn(group.provider, group.saved)
      ? group.saved.claudeAiConnectors
      : on === (group.provider.claudeAiConnectors === "on")
        ? "default"
        : on
          ? "on"
          : "off";
  return { ...staged, claudeAiConnectors };
}

/** Whether the group is on with some of its named connectors left out. */
export function connectorsPartial(group: ConnectorsGroup, staged: ThreadToolOverrides): boolean {
  return (
    connectorsOn(group.provider, staged) &&
    group.names.some((name) => staged.omittedMcpServers.includes(name))
  );
}

/**
 * The group's description: what is on, then whether the thread follows the provider default.
 * `reset` says that switching the group off cleared the connectors chosen one by one.
 */
export function connectorsDescription(
  group: ConnectorsGroup,
  staged: ThreadToolOverrides,
  reset: boolean,
): string {
  const on = connectorsOn(group.provider, staged);
  const onCount = group.names.filter((name) => !staged.omittedMcpServers.includes(name)).length;
  const state = !on
    ? reset
      ? "Connectors off, individual choices reset"
      : "Connectors off"
    : group.names.length === 0
      ? "Connectors on"
      : onCount === group.names.length
        ? `All ${group.names.length} connectors on`
        : `${onCount} of ${group.names.length} connectors on`;
  const source =
    staged.claudeAiConnectors === "default"
      ? "follows the provider default"
      : "set for this thread";
  return `${state}; ${source}`;
}

/**
 * Counts left-out built-ins, the claude.ai connectors as one item, and each MCP server the thread
 * leaves out. Hidden only off Claude.
 */
export function toolsLabel(
  provider: (Pick<ClaudeSettings, "omittedBuiltinTools"> & ConnectorsProvider) | null,
  overrides: ThreadToolOverrides | undefined,
): ToolsLabel {
  if (provider === null) return { hidden: true, onCount: 0, offCount: 0, text: "", value: "" };
  const rows = toolRows(provider);
  const connectors = connectorsOn(provider, overrides);
  const onCount = rows.filter((row) => isRowOn(row, overrides)).length + (connectors ? 1 : 0);
  const offCount = rows.length + 1 - onCount + (overrides?.omittedMcpServers.length ?? 0);
  const value =
    offCount === 0
      ? "all on"
      : onCount === 0
        ? `${offCount} off`
        : `${onCount} on · ${offCount} off`;
  return { hidden: false, onCount, offCount, text: `Tools ${value}`, value };
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
  claudeAiConnectors: "default",
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
      /** Undefined when a left-out server might be a connector, which makes the sum unknowable. */
      readonly estimatedTokens: number | undefined;
      readonly serversLeftOut: number;
    };

export function toolsFooterState(input: {
  readonly provider: ConnectorsProvider;
  readonly rows: ReadonlyArray<ToolRow>;
  readonly saved: ThreadToolOverrides;
  readonly staged: ThreadToolOverrides;
  /** Servers the inventory in hand shows are not connectors; empty until one loads. */
  readonly ordinaryServerNames: ReadonlyArray<string>;
  readonly turnRunning: boolean;
  readonly backgroundWork: boolean;
}): ToolsFooterState {
  if (input.turnRunning) return { kind: "running" };
  if (input.backgroundWork) return { kind: "background" };
  if (sameToolOverrides(input.saved, input.staged)) return { kind: "unchanged" };
  const on = input.rows.filter((row) => isRowOn(row, input.staged));
  const connectors = connectorsOn(input.provider, input.staged);
  // A left-out server the inventory cannot place might be a connector, which no estimate covers
  // on its own, so a sum is honest only when every left-out server is known to be ordinary.
  const unknownLeftOut = input.staged.omittedMcpServers.some(
    (name) => !input.ordinaryServerNames.includes(name),
  );
  return {
    kind: "changed",
    onCount: on.length + (connectors ? 1 : 0),
    estimatedTokens: unknownLeftOut
      ? undefined
      : on.reduce((sum, row) => sum + row.estimatedTokens, 0) +
        (connectors ? CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS : 0),
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
  /** Loaded by the live session; false when only a probe found it. */
  readonly active: boolean;
  readonly on: boolean;
}

export interface McpServerSections {
  readonly servers: ReadonlyArray<McpServerRow>;
  readonly connectors: ReadonlyArray<McpServerRow>;
}

export function mcpServerSections(input: {
  readonly inventory: ReadonlyArray<ThreadMcpServer>;
  readonly provider: ConnectorsProvider;
  readonly staged: ThreadToolOverrides;
}): McpServerSections {
  const groupOn = connectorsOn(input.provider, input.staged);
  const row = (server: ThreadMcpServer): McpServerRow => ({
    name: server.name,
    active: server.active,
    // A connector is in the thread only while the group is on.
    on: !input.staged.omittedMcpServers.includes(server.name) && (!server.connector || groupOn),
  });
  return {
    servers: input.inventory.filter((server) => !server.connector).map(row),
    connectors: input.inventory.filter((server) => server.connector).map(row),
  };
}

/**
 * Switching one of the group's connectors on while the group is off turns the group on for it
 * alone, leaving the other connectors out.
 */
export function withMcpServerSwitched(
  staged: ThreadToolOverrides,
  server: string,
  on: boolean,
  group: ConnectorsGroup,
): ThreadToolOverrides {
  if (on && group.names.includes(server) && !connectorsOn(group.provider, staged)) {
    return {
      ...withConnectorsGroup(group, staged, true),
      omittedMcpServers: [
        ...staged.omittedMcpServers.filter((name) => !group.names.includes(name)),
        ...group.names.filter((name) => name !== server),
      ],
    };
  }
  const rest = staged.omittedMcpServers.filter((name) => name !== server);
  return { ...staged, omittedMcpServers: on ? rest : [...rest, server] };
}

/** The group switch; turning it off forgets which connectors were left out one by one. */
export function withConnectorsMaster(
  staged: ThreadToolOverrides,
  on: boolean,
  group: ConnectorsGroup,
): ThreadToolOverrides {
  const next = withConnectorsGroup(group, staged, on);
  return on
    ? next
    : {
        ...next,
        omittedMcpServers: next.omittedMcpServers.filter((name) => !group.names.includes(name)),
      };
}
