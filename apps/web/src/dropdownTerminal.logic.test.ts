import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  clampDropdownTerminalHeight,
  dropdownTerminalMoveTargets,
  dropdownTerminalToFocus,
} from "./dropdownTerminal.logic";
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

describe("dropdownTerminalMoveTargets", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const thread = (
    environmentId: EnvironmentId,
    id: string,
    updatedAt: string,
    archivedAt: string | null = null,
  ) => ({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    worktreePath: `/worktrees/${id}`,
    archivedAt,
    updatedAt,
  });
  const threads = [
    thread(local, "old", "2026-01-01"),
    thread(local, "shown", "2026-01-02"),
    thread(local, "archived", "2026-01-05", "2026-01-06"),
    thread(local, "recent", "2026-01-04"),
    thread(remote, "elsewhere", "2026-01-07"),
  ];

  it("lists the shown thread first, then the machine's recent unarchived threads", () => {
    const targets = dropdownTerminalMoveTargets({
      environmentId: local,
      shownThreadRef: scopeThreadRef(local, ThreadId.make("shown")),
      threads,
    });
    expect(targets.map((target) => [target.title, target.shown, target.reason])).toEqual([
      ["shown", true, null],
      ["recent", false, null],
      ["old", false, null],
    ]);
    expect(targets[0]?.worktreePath).toBe("/worktrees/shown");
  });

  it("keeps a shown thread on another machine listed but unavailable", () => {
    const targets = dropdownTerminalMoveTargets({
      environmentId: local,
      shownThreadRef: scopeThreadRef(remote, ThreadId.make("elsewhere")),
      threads,
    });
    expect(targets.map((target) => [target.title, target.reason])).toEqual([
      ["elsewhere", "On another machine"],
      ["recent", null],
      ["shown", null],
      ["old", null],
    ]);
  });
});
