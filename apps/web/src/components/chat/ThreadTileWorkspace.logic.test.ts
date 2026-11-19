import { describe, expect, it } from "vite-plus/test";
import type { RightPanelSurface } from "../../rightPanelStore";
import { newTabId } from "../../threadTileLayout";
import { fitTileTabs, tileCloseConfirmation } from "./ThreadTileWorkspace.logic";

const terminal = (id: string, terminalId: string): RightPanelSurface => ({
  id: `terminal:${id}`,
  kind: "terminal",
  resourceId: terminalId,
});
const surfaces = [
  terminal("a", "t1"),
  terminal("b", "t3"),
  { id: "diff", kind: "diff" },
] satisfies RightPanelSurface[];
const labels = new Map([
  ["t1", "npm run dev"],
  ["t3", "vite"],
]);

describe("tileCloseConfirmation", () => {
  it.each([
    ["an empty tile", [], [], null],
    ["one idle tab", ["diff"], ["t1"], null],
    ["one idle terminal", ["terminal:a"], [], null],
    ["chat beside an empty new tab", ["conversation", newTabId("x")], [], null],
    ["several tabs", ["diff", "conversation"], [], null],
    [
      "a running terminal",
      ["terminal:a"],
      ["t1"],
      {
        title: "Close this tile?",
        description: "npm run dev is still running and will be stopped.",
      },
    ],
    [
      "running terminals among several tabs",
      ["terminal:a", "terminal:b", "diff"],
      ["t1", "t2"],
      {
        title: "Close all 3 tabs in this tile?",
        description: "npm run dev is still running and will be stopped.",
      },
    ],
  ])("asks the right question for %s", (_name, tabIds, runningTerminalIds, expected) => {
    expect(
      tileCloseConfirmation({ tabIds, surfaces, runningTerminalIds, terminalLabelsById: labels }),
    ).toEqual(expected);
  });
});

describe("fitTileTabs", () => {
  // Four 100px tabs, a 30px chip, and split (44), float (22), maximize (22), close (22).
  const base = {
    tabs: [100, 100, 100, 100],
    controls: [44, 22, 22, 22],
    chip: 30,
    truncatedTab: 60,
  };
  it.each([
    [
      "all fit with every control",
      510,
      3,
      { shown: [0, 1, 2, 3], mode: "full", hiddenControls: 0 },
    ],
    ["split hides first", 466, 3, { shown: [0, 1, 2, 3], mode: "full", hiddenControls: 1 }],
    ["then float", 444, 3, { shown: [0, 1, 2, 3], mode: "full", hiddenControls: 2 }],
    ["then maximize", 422, 3, { shown: [0, 1, 2, 3], mode: "full", hiddenControls: 3 }],
    [
      "then close, before any tab folds",
      400,
      0,
      { shown: [0, 1, 2, 3], mode: "full", hiddenControls: 4 },
    ],
    ["the tail folds into +N", 399, 0, { shown: [0, 1, 2], mode: "full", hiddenControls: 4 }],
    [
      "the active tab takes the last place",
      399,
      3,
      { shown: [0, 1, 3], mode: "full", hiddenControls: 4 },
    ],
    ["one tab beside the chip", 130, 2, { shown: [2], mode: "full", hiddenControls: 4 }],
    ["the lone active tab truncates", 129, 2, { shown: [2], mode: "truncated", hiddenControls: 4 }],
    ["then shows its icon", 89, 2, { shown: [2], mode: "icon", hiddenControls: 4 }],
  ] as const)("%s", (_name, room, activeIndex, expected) => {
    expect(fitTileTabs({ ...base, room, activeIndex })).toEqual(expected);
  });
  it("needs no chip room for a tile's only tab", () => {
    const single = { ...base, tabs: [100], activeIndex: 0 };
    expect(fitTileTabs({ ...single, room: 100 }).mode).toBe("full");
    expect(fitTileTabs({ ...single, room: 60 }).mode).toBe("truncated");
    expect(fitTileTabs({ ...single, room: 59 }).mode).toBe("icon");
  });
  it("shows a short active tab as its icon rather than stretching it to truncate", () => {
    expect(fitTileTabs({ ...base, tabs: [100, 50], room: 70, activeIndex: 1 })).toEqual({
      shown: [1],
      mode: "icon",
      hiddenControls: 4,
    });
  });
});
