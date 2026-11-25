import { ProviderInstanceId, type ThreadToolOverrides } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeSettingsForInstance,
  EMPTY_TOOL_OVERRIDES,
  mcpServerSections,
  threadTurnRunning,
  withConnectorsMaster,
  withMcpServerSwitched,
  toolRows,
  toolsFooterState,
  toolsLabel,
  withRowSwitched,
} from "./ComposerToolsControl.logic";

const ALL_SEVEN = [
  "Artifact",
  "ArtifactData",
  "ArtifactComments",
  "Task",
  "Workflow",
  "ScheduleWakeup",
  "ReportFindings",
] as const;
const defaults = { omittedBuiltinTools: ALL_SEVEN, claudeAiConnectors: "inherit" } as const;
const connectorsOff = { ...defaults, claudeAiConnectors: "off" } as const;
const wakeupAndConnectors: ThreadToolOverrides = {
  enabledBuiltinTools: ["ScheduleWakeup"],
  claudeAiConnectors: true,
  omittedMcpServers: [],
};

describe("toolsLabel", () => {
  it.each([
    ["provider defaults", defaults, undefined, "Tools 7 off"],
    ["connectors off at the provider", connectorsOff, undefined, "Tools 8 off"],
    ["two switched on", connectorsOff, wakeupAndConnectors, "Tools 2 on · 6 off"],
    // Connectors the provider leaves to Claude Code count only once the thread switches them on.
    [
      "connectors on over an inherited provider",
      defaults,
      wakeupAndConnectors,
      "Tools 2 on · 6 off",
    ],
    ["an override with nothing on", defaults, EMPTY_TOOL_OVERRIDES, "Tools 7 off"],
    // A left-out MCP server is one more item, whatever its name.
    [
      "two MCP servers left out",
      defaults,
      { ...EMPTY_TOOL_OVERRIDES, omittedMcpServers: ["fixture-notes", "claude.ai Fixture Board"] },
      "Tools 9 off",
    ],
  ] as const)("reads %s", (_name, provider, overrides, text) => {
    expect(toolsLabel(provider, overrides)).toMatchObject({ hidden: false, text });
  });

  it("hides only off Claude, and reads all on when nothing is left out", () => {
    expect(toolsLabel(null, undefined).hidden).toBe(true);
    const keepsEverything = { omittedBuiltinTools: [], claudeAiConnectors: "inherit" } as const;
    expect(toolsLabel(keepsEverything, undefined)).toMatchObject({
      hidden: false,
      text: "Tools all on",
    });
    expect(
      toolsLabel(keepsEverything, { ...EMPTY_TOOL_OVERRIDES, claudeAiConnectors: true }),
    ).toMatchObject({ hidden: false, text: "Tools 1 on · 0 off" });
  });
});

describe("toolRows", () => {
  it("lists the built-in tools the provider leaves out, largest estimate first", () => {
    expect(toolRows(connectorsOff).map((row) => [row.key, row.estimatedTokens])).toEqual([
      ["Artifact", 12_900],
      ["Task", 3_300],
      ["Workflow", 2_100],
      ["ScheduleWakeup", 1_700],
      ["ReportFindings", 900],
      ["ArtifactData", 500],
      ["ArtifactComments", 70],
    ]);
  });
});

describe("toolsFooterState", () => {
  const rows = toolRows(connectorsOff);
  const base = {
    rows,
    saved: EMPTY_TOOL_OVERRIDES,
    connectorNames: ["claude.ai Fixture Board", "claude.ai Fixture Mail"],
    reload: undefined,
    turnRunning: false,
    backgroundWork: false,
  };

  it("sums the switched-on estimates, connectors as a whole", () => {
    expect(toolsFooterState({ ...base, staged: wakeupAndConnectors })).toEqual({
      kind: "changed",
      onCount: 2,
      estimatedTokens: 4_900,
      serversLeftOut: 0,
    });
  });

  it("gives no sum for a partial connector selection", () => {
    expect(
      toolsFooterState({
        ...base,
        staged: { ...wakeupAndConnectors, omittedMcpServers: ["claude.ai Fixture Mail"] },
      }),
    ).toEqual({ kind: "changed", onCount: 2, estimatedTokens: undefined, serversLeftOut: 1 });
  });

  it("offers a reload anyway when nothing changed, and says when the last one failed", () => {
    expect(toolsFooterState({ ...base, staged: EMPTY_TOOL_OVERRIDES })).toEqual({
      kind: "unchanged",
      lastReloadFailed: false,
    });
    expect(toolsFooterState({ ...base, staged: EMPTY_TOOL_OVERRIDES, reload: "failed" })).toEqual({
      kind: "unchanged",
      lastReloadFailed: true,
    });
  });

  it("shows a pending reload first, then a running turn, then background work", () => {
    const staged = wakeupAndConnectors;
    const busy = { ...base, staged, turnRunning: true, backgroundWork: true };
    expect(toolsFooterState({ ...busy, reload: "pending" }).kind).toBe("reloading");
    expect(toolsFooterState(busy).kind).toBe("running");
    expect(toolsFooterState({ ...base, staged, backgroundWork: true }).kind).toBe("background");
  });

  it("treats a held queue as idle and an active run as running", () => {
    expect(threadTurnRunning("queued")).toBe(false);
    expect(threadTurnRunning("idle")).toBe(false);
    expect(threadTurnRunning("running")).toBe(true);
    expect(threadTurnRunning("waiting")).toBe(true);
  });
});

describe("withRowSwitched", () => {
  it("keeps the contract's order, so equal selections compare equal", () => {
    const staged = withRowSwitched(
      withRowSwitched(EMPTY_TOOL_OVERRIDES, "ScheduleWakeup", true),
      "Artifact",
      true,
    );
    expect(staged.enabledBuiltinTools).toEqual(["Artifact", "ScheduleWakeup"]);
  });
});

describe("claudeSettingsForInstance", () => {
  it("reads the default Claude instance without a saved entry and skips other drivers", () => {
    expect(
      claudeSettingsForInstance({ providerInstances: {} }, ProviderInstanceId.make("claudeAgent"))
        ?.omittedBuiltinTools,
    ).toEqual(ALL_SEVEN);
    expect(
      claudeSettingsForInstance({ providerInstances: {} }, ProviderInstanceId.make("codex")),
    ).toBeNull();
    const work = ProviderInstanceId.make("claude-work");
    expect(
      claudeSettingsForInstance(
        {
          providerInstances: {
            [work]: { driver: "claudeAgent" as never, config: { claudeAiConnectors: "off" } },
          },
        },
        work,
      )?.claudeAiConnectors,
    ).toBe("off");
  });
});

describe("MCP servers", () => {
  const inventory = [
    { name: "fixture-notes", connector: false, status: "connected", active: false },
    { name: "claude.ai Fixture Board", connector: true, status: "connected", active: true },
    { name: "claude.ai Fixture Mail", connector: true, status: "pending", active: false },
  ];
  const connectorNames = ["claude.ai Fixture Board", "claude.ai Fixture Mail"];

  it("offers connector switches only where the connectors load", () => {
    const switchable = (
      provider: typeof defaults | typeof connectorsOff,
      staged: ThreadToolOverrides,
    ) =>
      mcpServerSections({ inventory, provider, staged }).connectors.map((row) => [
        row.name,
        row.switchable,
      ]);
    // The provider keeps them out and the thread has not forced them on: nothing loads.
    expect(switchable(connectorsOff, EMPTY_TOOL_OVERRIDES)).toEqual([
      ["claude.ai Fixture Board", false],
      ["claude.ai Fixture Mail", false],
    ]);
    expect(switchable(connectorsOff, wakeupAndConnectors)).toEqual([
      ["claude.ai Fixture Board", true],
      ["claude.ai Fixture Mail", true],
    ]);
    // Left to Claude Code, only the connector the live session loaded is known to load.
    expect(switchable(defaults, EMPTY_TOOL_OVERRIDES)).toEqual([
      ["claude.ai Fixture Board", true],
      ["claude.ai Fixture Mail", false],
    ]);
  });

  it("leaves a server out by name and brings it back", () => {
    const off = withMcpServerSwitched(EMPTY_TOOL_OVERRIDES, "fixture-notes", false);
    expect(off.omittedMcpServers).toEqual(["fixture-notes"]);
    expect(withMcpServerSwitched(off, "fixture-notes", true).omittedMcpServers).toEqual([]);
    expect(mcpServerSections({ inventory, provider: defaults, staged: off }).servers).toEqual([
      { name: "fixture-notes", active: false, switchable: true, on: false },
    ]);
  });

  it("turning the master off forgets per-connector choices and keeps other servers", () => {
    const staged = withConnectorsMaster(
      { ...wakeupAndConnectors, omittedMcpServers: ["fixture-notes", "claude.ai Fixture Mail"] },
      false,
      connectorNames,
    );
    expect(staged.claudeAiConnectors).toBe(false);
    expect(staged.omittedMcpServers).toEqual(["fixture-notes"]);
  });
});
