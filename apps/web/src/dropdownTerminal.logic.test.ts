import { describe, expect, it } from "vite-plus/test";

import { clampDropdownTerminalHeight, dropdownTerminalToFocus } from "./dropdownTerminal.logic";
import type { RightPanelSurface } from "./rightPanelStore";
import type { ThreadTileLayout } from "./threadTileLayout";

const terminal = (id: string): RightPanelSurface => ({
  id: `terminal:${id}`,
  kind: "terminal",
  resourceId: id,
});

const layout: ThreadTileLayout = {
  root: {
    kind: "split",
    id: "split",
    axis: "horizontal",
    ratio: 0.5,
    first: {
      kind: "group",
      id: "left",
      tabs: ["terminal:a", "terminal:b"],
      activeTabId: "terminal:b",
    },
    second: { kind: "group", id: "right", tabs: ["new-tab:x"], activeTabId: "new-tab:x" },
  },
  focusedGroupId: "left",
  maximizedGroupId: null,
};

describe("dropdownTerminalToFocus", () => {
  it.each([
    ["the focused tile's active terminal", layout, ["a", "b"], "b"],
    [
      "another tile's active terminal when the focused one is choosing",
      { ...layout, focusedGroupId: "right" },
      ["a", "b"],
      "b",
    ],
    ["none, so a new one starts", layout, [], null],
  ] as const)("picks %s", (_, current, ids, expected) => {
    expect(dropdownTerminalToFocus(current, ids.map(terminal))).toBe(expected);
  });
});

describe("clampDropdownTerminalHeight", () => {
  it.each([
    [40, 900, 160],
    [500, 900, 500],
    [2000, 900, 820],
    [300, 200, 160],
  ])("clamps %d in a %dpx window to %d", (height, viewport, expected) => {
    expect(clampDropdownTerminalHeight(height, viewport)).toBe(expected);
  });
});
