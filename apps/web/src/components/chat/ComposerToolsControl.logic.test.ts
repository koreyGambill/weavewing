import {
  CLAUDE_REMOVABLE_BUILTIN_TOOLS,
  ProviderInstanceId,
  type ThreadToolOverrides,
} from "@t3tools/contracts";
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
    // Everything the provider leaves out is switched on, so nothing is effectively off.
    expect(
      toolsLabel(
        { omittedBuiltinTools: ["ScheduleWakeup"], claudeAiConnectors: "off" },
        wakeupAndConnectors,
      ),
    ).toMatchObject({ hidden: false, text: "Tools all on" });
  });

  it("gives the thread menu the value after Tools", () => {
    expect(toolsLabel(connectorsOff, undefined).value).toBe("8 off");
    expect(toolsLabel(connectorsOff, wakeupAndConnectors).value).toBe("2 on · 6 off");
    expect(
      toolsLabel({ omittedBuiltinTools: [], claudeAiConnectors: "inherit" }, undefined).value,
    ).toBe("all on");
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

  it("describes each tool with the settings checklist's wording", () => {
    const settings = new Map(CLAUDE_REMOVABLE_BUILTIN_TOOLS.map((tool) => [tool.value, tool]));
    for (const row of toolRows(connectorsOff)) {
      expect(row.description).toBe(settings.get(row.key)?.description);
    }
    expect(toolRows(connectorsOff)[0]?.description).toBe("Publish claude.ai artifact pages");
  });
});

describe("toolsFooterState", () => {
  const rows = toolRows(connectorsOff);
  const base = {
    rows,
    saved: EMPTY_TOOL_OVERRIDES,
    ordinaryServerNames: ["fixture-notes"],
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

  it("gives no sum unless every left-out server is known to be an ordinary one", () => {
    const partial = { ...wakeupAndConnectors, omittedMcpServers: ["claude.ai Fixture Mail"] };
    expect(toolsFooterState({ ...base, staged: partial })).toEqual({
      kind: "changed",
      onCount: 2,
      estimatedTokens: undefined,
      serversLeftOut: 1,
    });
    // An inventory still loading, or one that loaded without the left-out name, proves nothing.
    expect(
      toolsFooterState({ ...base, saved: partial, staged: partial, ordinaryServerNames: [] }).kind,
    ).toBe("unchanged");
    expect(
      toolsFooterState({
        ...base,
        saved: partial,
        staged: { ...partial, enabledBuiltinTools: ["Artifact"] },
      }),
    ).toMatchObject({ estimatedTokens: undefined });
    // Connectors left to Claude Code do not make an unplaced left-out server safe to sum.
    expect(
      toolsFooterState({
        ...base,
        staged: {
          ...EMPTY_TOOL_OVERRIDES,
          enabledBuiltinTools: ["Artifact"],
          omittedMcpServers: ["claude.ai Fixture Mail"],
        },
      }),
    ).toEqual({ kind: "changed", onCount: 1, estimatedTokens: undefined, serversLeftOut: 1 });
    const ordinaryLeftOut = { ...wakeupAndConnectors, omittedMcpServers: ["fixture-notes"] };
    expect(toolsFooterState({ ...base, staged: ordinaryLeftOut })).toMatchObject({
      estimatedTokens: 4_900,
      serversLeftOut: 1,
    });
  });

  it("offers a reload anyway when nothing changed", () => {
    expect(toolsFooterState({ ...base, staged: EMPTY_TOOL_OVERRIDES })).toEqual({
      kind: "unchanged",
    });
  });

  it("blocks during a running turn, then background work", () => {
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
    // With the provider keeping them out, each connector can be picked on its own, from off.
    expect(switchable(connectorsOff, EMPTY_TOOL_OVERRIDES)).toEqual([
      ["claude.ai Fixture Board", true],
      ["claude.ai Fixture Mail", true],
    ]);
    expect(
      mcpServerSections({
        inventory,
        provider: connectorsOff,
        staged: EMPTY_TOOL_OVERRIDES,
      }).connectors.map((row) => row.on),
    ).toEqual([false, false]);
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

  it("switching one connector on with the group off turns the group on for it alone", () => {
    const staged = withMcpServerSwitched(
      EMPTY_TOOL_OVERRIDES,
      "claude.ai Fixture Board",
      true,
      connectorNames,
    );
    expect(staged).toEqual({
      enabledBuiltinTools: [],
      claudeAiConnectors: true,
      omittedMcpServers: ["claude.ai Fixture Mail"],
    });
    expect(
      mcpServerSections({ inventory, provider: connectorsOff, staged }).connectors.map((row) => [
        row.name,
        row.on,
      ]),
    ).toEqual([
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
