import {
  CLAUDE_REMOVABLE_BUILTIN_TOOLS,
  ProviderInstanceId,
  type ThreadToolOverrides,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeSettingsForInstance,
  connectorsOn,
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
const defaults = { omittedBuiltinTools: ALL_SEVEN, claudeAiConnectors: "off" } as const;
const connectorsOff = defaults;
const connectorsDefaultOn = { ...defaults, claudeAiConnectors: "on" } as const;
const wakeupAndConnectors: ThreadToolOverrides = {
  enabledBuiltinTools: ["ScheduleWakeup"],
  claudeAiConnectors: "on",
  omittedMcpServers: [],
};
const connectorsForcedOff: ThreadToolOverrides = {
  ...EMPTY_TOOL_OVERRIDES,
  claudeAiConnectors: "off",
};

describe("toolsLabel", () => {
  it.each([
    ["provider defaults", defaults, undefined, "Tools 8 off"],
    ["connectors on by default", connectorsDefaultOn, undefined, "Tools 1 on · 7 off"],
    ["two switched on", defaults, wakeupAndConnectors, "Tools 2 on · 6 off"],
    [
      "connectors off for the thread over an On default",
      connectorsDefaultOn,
      connectorsForcedOff,
      "Tools 8 off",
    ],
    ["an override with nothing on", defaults, EMPTY_TOOL_OVERRIDES, "Tools 8 off"],
    // A left-out MCP server is one more item, whatever its name.
    [
      "two MCP servers left out",
      defaults,
      { ...EMPTY_TOOL_OVERRIDES, omittedMcpServers: ["fixture-notes", "claude.ai Fixture Board"] },
      "Tools 10 off",
    ],
  ] as const)("reads %s", (_name, provider, overrides, text) => {
    expect(toolsLabel(provider, overrides)).toMatchObject({ hidden: false, text });
  });

  it("hides only off Claude, and reads all on when nothing is left out", () => {
    expect(toolsLabel(null, undefined).hidden).toBe(true);
    const keepsEverything = { omittedBuiltinTools: [], claudeAiConnectors: "on" } as const;
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
    expect(toolsLabel(defaults, undefined).value).toBe("8 off");
    expect(toolsLabel(defaults, wakeupAndConnectors).value).toBe("2 on · 6 off");
    expect(toolsLabel({ omittedBuiltinTools: [], claudeAiConnectors: "on" }, undefined).value).toBe(
      "all on",
    );
  });
});

describe("connectorsOn", () => {
  it.each([
    ["off", "default", false],
    ["off", "on", true],
    ["on", "default", true],
    ["on", "off", false],
  ] as const)("reads provider %s with the thread on %s as %s", (provider, thread, on) => {
    expect(
      connectorsOn(
        { claudeAiConnectors: provider },
        { ...EMPTY_TOOL_OVERRIDES, claudeAiConnectors: thread },
      ),
    ).toBe(on);
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
    provider: defaults,
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
            [work]: { driver: "claudeAgent" as never, config: { claudeAiConnectors: "on" } },
          },
        },
        work,
      )?.claudeAiConnectors,
    ).toBe("on");
  });
});

describe("MCP servers", () => {
  const inventory = [
    { name: "fixture-notes", connector: false, status: "connected", active: false },
    { name: "claude.ai Fixture Board", connector: true, status: "connected", active: true },
    { name: "claude.ai Fixture Mail", connector: true, status: "pending", active: false },
  ];
  const connectorNames = ["claude.ai Fixture Board", "claude.ai Fixture Mail"];

  const sections = (
    provider: typeof defaults | typeof connectorsDefaultOn,
    staged: ThreadToolOverrides,
  ) =>
    mcpServerSections({ inventory, provider, staged }).connectors.map((row) => [row.name, row.on]);

  it("shows each connector on or off with the group's effective value", () => {
    expect(sections(defaults, EMPTY_TOOL_OVERRIDES)).toEqual([
      ["claude.ai Fixture Board", false],
      ["claude.ai Fixture Mail", false],
    ]);
    expect(sections(connectorsDefaultOn, EMPTY_TOOL_OVERRIDES)).toEqual([
      ["claude.ai Fixture Board", true],
      ["claude.ai Fixture Mail", true],
    ]);
    expect(sections(connectorsDefaultOn, connectorsForcedOff)).toEqual([
      ["claude.ai Fixture Board", false],
      ["claude.ai Fixture Mail", false],
    ]);
  });

  it("switching one connector on with the group off turns the group on for it alone", () => {
    for (const provider of [defaults, connectorsDefaultOn]) {
      const groupOff = provider === defaults ? EMPTY_TOOL_OVERRIDES : connectorsForcedOff;
      const staged = withMcpServerSwitched(
        groupOff,
        "claude.ai Fixture Board",
        true,
        provider,
        connectorNames,
      );
      expect(connectorsOn(provider, staged)).toBe(true);
      expect(staged.omittedMcpServers).toEqual(["claude.ai Fixture Mail"]);
      expect(sections(provider, staged)).toEqual([
        ["claude.ai Fixture Board", true],
        ["claude.ai Fixture Mail", false],
      ]);
    }
  });

  it("switching the group back to the provider default clears the thread's setting", () => {
    for (const provider of [defaults, connectorsDefaultOn]) {
      const defaultOn = provider.claudeAiConnectors === "on";
      const away = withConnectorsMaster(EMPTY_TOOL_OVERRIDES, !defaultOn, provider, connectorNames);
      expect(away.claudeAiConnectors).toBe(defaultOn ? "off" : "on");
      const back = withConnectorsMaster(away, defaultOn, provider, connectorNames);
      expect(back.claudeAiConnectors).toBe("default");
    }
  });

  it("leaves a server out by name and brings it back", () => {
    const off = withMcpServerSwitched(EMPTY_TOOL_OVERRIDES, "fixture-notes", false, defaults);
    expect(off.omittedMcpServers).toEqual(["fixture-notes"]);
    expect(withMcpServerSwitched(off, "fixture-notes", true, defaults).omittedMcpServers).toEqual(
      [],
    );
    expect(mcpServerSections({ inventory, provider: defaults, staged: off }).servers).toEqual([
      { name: "fixture-notes", active: false, on: false },
    ]);
  });

  it("turning the group off forgets per-connector choices and keeps other servers", () => {
    const staged = withConnectorsMaster(
      { ...wakeupAndConnectors, omittedMcpServers: ["fixture-notes", "claude.ai Fixture Mail"] },
      false,
      defaults,
      connectorNames,
    );
    expect(connectorsOn(defaults, staged)).toBe(false);
    expect(staged.omittedMcpServers).toEqual(["fixture-notes"]);
  });
});
