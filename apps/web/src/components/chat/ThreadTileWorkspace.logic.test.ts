import { describe, expect, it } from "vite-plus/test";
import type { RightPanelSurface } from "../../rightPanelStore";
import {
  applyTileAction,
  newTabId,
  syncTileLayout,
  TILE_MIN_WIDTH_PX,
} from "../../threadTileLayout";
import {
  fitTileTabs,
  splitTooNarrow,
  tileCloseConfirmation,
  tileDropZone,
} from "./ThreadTileWorkspace.logic";

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

describe("splitTooNarrow", () => {
  // conversation-group | panels-group, half and half.
  const pair = applyTileAction(syncTileLayout(undefined, [], ["a", "b"], "a", true), {
    type: "resize",
    splitId: "initial-split",
    ratio: 0.5,
  });
  const splitRight = (targetGroupId: string) =>
    ({
      type: "new-group",
      targetGroupId,
      axis: "horizontal",
      side: "after",
      groupId: "added",
      splitId: "added-split",
    }) as const;

  it("needs two minimum tiles of width in the pane being split", () => {
    expect(splitTooNarrow(pair, splitRight("panels-group"), 4 * TILE_MIN_WIDTH_PX)).toBe(false);
    expect(splitTooNarrow(pair, splitRight("panels-group"), 4 * TILE_MIN_WIDTH_PX - 4)).toBe(true);
    expect(splitTooNarrow(pair, { ...splitRight("panels-group"), axis: "vertical" }, 300)).toBe(
      false,
    );
  });

  it("never borrows width from a neighbouring tile", () => {
    const lopsided = applyTileAction(pair, {
      type: "resize",
      splitId: "initial-split",
      ratio: 0.3,
    });
    expect(splitTooNarrow(lopsided, splitRight("conversation-group"), 1000)).toBe(true);
    expect(splitTooNarrow(lopsided, splitRight("panels-group"), 1000)).toBe(false);
  });

  it("counts the width a move gives back when it empties its source tile", () => {
    const edgeDrop = {
      type: "split",
      tabId: "conversation",
      targetGroupId: "panels-group",
      axis: "horizontal",
      side: "after",
      groupId: "dropped",
      splitId: "dropped-split",
    } as const;
    expect(splitTooNarrow(pair, edgeDrop, 400)).toBe(false);
    const crowded = applyTileAction(pair, {
      type: "move",
      tabId: "b",
      targetGroupId: "conversation-group",
    });
    // The source keeps a tab, so the target pane stays at half the canvas.
    expect(splitTooNarrow(crowded, edgeDrop, 400)).toBe(true);
  });

  it("measures a floating tile by its own width", () => {
    const float = (width: number) =>
      applyTileAction(pair, {
        type: "float-group",
        groupId: "panels-group",
        rect: { x: 0.1, y: 0.1, width, height: 0.5 },
      });
    expect(splitTooNarrow(float(0.256), splitRight("panels-group"), 1000)).toBe(true);
    expect(splitTooNarrow(float(0.5), splitRight("panels-group"), 1000)).toBe(false);
  });

  it("measures a maximized tile where it docks once the split restores the layout", () => {
    const maximized = applyTileAction(pair, { type: "maximize", groupId: "panels-group" });
    expect(splitTooNarrow(maximized, splitRight("panels-group"), 600)).toBe(true);
    expect(splitTooNarrow(maximized, splitRight("panels-group"), 700)).toBe(false);
    expect(
      splitTooNarrow(maximized, { ...splitRight("panels-group"), axis: "vertical" }, 600),
    ).toBe(false);
  });
});

describe("tileDropZone", () => {
  const none = () => false;
  const sidesRefused = (zone: string) => zone === "left" || zone === "right";
  it.each([
    ["the nearest edge within reach", 0.9, 0.5, none, "right"],
    ["the center beyond every edge's reach", 0.5, 0.5, none, "center"],
    ["no target at a refused edge, never the center", 0.9, 0.5, sidesRefused, null],
    ["another edge only where it is nearest", 0.5, 0.1, sidesRefused, "top"],
    ["the center still beyond reach", 0.5, 0.5, sidesRefused, "center"],
  ] as const)("gives %s", (_name, x, y, refused, expected) => {
    expect(tileDropZone(x, y, refused)).toBe(expected);
  });
});
