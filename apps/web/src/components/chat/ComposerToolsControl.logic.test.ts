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

  it("hides for a thread not on Claude, and when nothing is left out or switched on", () => {
    expect(toolsLabel(null, undefined).hidden).toBe(true);
    expect(
      toolsLabel({ omittedBuiltinTools: [], claudeAiConnectors: "inherit" }, undefined).hidden,
    ).toBe(true);
    expect(
      toolsLabel(
        { omittedBuiltinTools: [], claudeAiConnectors: "inherit" },
        { ...EMPTY_TOOL_OVERRIDES, claudeAiConnectors: true },
      ),
    ).toMatchObject({ hidden: false, text: "Tools 1 on · 0 off" });
  });
});

describe("toolRows", () => {
  it("lists what the provider leaves out, largest estimate first", () => {
    expect(toolRows(connectorsOff, undefined).map((row) => [row.key, row.estimatedTokens])).toEqual(
      [
        ["Artifact", 12_900],
        ["Task", 3_300],
        ["claudeAiConnectors", 3_200],
        ["Workflow", 2_100],
        ["ScheduleWakeup", 1_700],
        ["ReportFindings", 900],
        ["ArtifactData", 500],
        ["ArtifactComments", 70],
      ],
    );
  });
});

describe("toolsFooterState", () => {
  const rows = toolRows(connectorsOff, undefined);
  const base = { rows, saved: EMPTY_TOOL_OVERRIDES, turnRunning: false, backgroundWork: false };

  it("sums the switched-on estimates", () => {
    expect(toolsFooterState({ ...base, staged: wakeupAndConnectors })).toEqual({
      kind: "changed",
      onCount: 2,
      estimatedTokens: 4_900,
      serversLeftOut: 0,
    });
  });

  it("offers a reload anyway when nothing changed, in any switch order", () => {
    const staged = withRowSwitched(
      withRowSwitched(EMPTY_TOOL_OVERRIDES, "ScheduleWakeup", true),
      "claudeAiConnectors",
      true,
    );
    expect(toolsFooterState({ ...base, saved: wakeupAndConnectors, staged }).kind).toBe(
      "unchanged",
    );
  });

  it("blocks while a turn runs, then while background work runs", () => {
    const staged = wakeupAndConnectors;
    expect(
      toolsFooterState({ ...base, staged, turnRunning: true, backgroundWork: true }).kind,
    ).toBe("running");
    expect(toolsFooterState({ ...base, staged, backgroundWork: true }).kind).toBe("background");
  });

  it("treats a held queue as idle and an active run as running", () => {
    expect(threadTurnRunning("queued")).toBe(false);
    expect(threadTurnRunning("idle")).toBe(false);
    expect(threadTurnRunning("running")).toBe(true);
    expect(threadTurnRunning("waiting")).toBe(true);
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
    { name: "fixture-notes", connector: false, status: "connected" },
    { name: "claude.ai Fixture Board", connector: true, status: "pending" },
    { name: "claude.ai Fixture Mail", connector: true, status: "pending" },
  ];
  const connectorNames = ["claude.ai Fixture Board", "claude.ai Fixture Mail"];

  it("switching one connector on with the master off turns the master on for it alone", () => {
    const staged = withMcpServerSwitched({
      staged: EMPTY_TOOL_OVERRIDES,
      server: inventory[1]!,
      on: true,
      connectorNames,
      masterDecides: true,
    });
    expect(staged).toEqual({
      enabledBuiltinTools: [],
      claudeAiConnectors: true,
      omittedMcpServers: ["claude.ai Fixture Mail"],
    });
    expect(
      mcpServerSections({ inventory, provider: connectorsOff, saved: EMPTY_TOOL_OVERRIDES, staged })
        .connectors,
    ).toEqual([
      { name: "claude.ai Fixture Board", on: true },
      { name: "claude.ai Fixture Mail", on: false },
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

  it("leaves Claude Code's choice alone where the master does not decide", () => {
    const sections = mcpServerSections({
      inventory,
      provider: defaults,
      saved: EMPTY_TOOL_OVERRIDES,
      staged: { ...EMPTY_TOOL_OVERRIDES, omittedMcpServers: ["claude.ai Fixture Mail"] },
    });
    expect(sections.servers).toEqual([{ name: "fixture-notes", on: true }]);
    expect(sections.connectors).toEqual([
      { name: "claude.ai Fixture Board", on: true },
      { name: "claude.ai Fixture Mail", on: false },
    ]);
  });
});
