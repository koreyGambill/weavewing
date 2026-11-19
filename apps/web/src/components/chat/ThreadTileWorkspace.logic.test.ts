import { describe, expect, it } from "vite-plus/test";
import type { RightPanelSurface } from "../../rightPanelStore";
import { newTabId } from "../../threadTileLayout";
import { tileCloseConfirmation } from "./ThreadTileWorkspace.logic";

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
    [
      "several tabs",
      ["diff", "conversation"],
      [],
      { title: "Close all 2 tabs in this tile?", description: null },
    ],
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
      ["t1", "t2", "t3"],
      {
        title: "Close all 3 tabs in this tile?",
        description: "npm run dev and vite are still running and will be stopped.",
      },
    ],
  ])("asks the right question for %s", (_name, tabIds, runningTerminalIds, expected) => {
    expect(
      tileCloseConfirmation({ tabIds, surfaces, runningTerminalIds, terminalLabelsById: labels }),
    ).toEqual(expected);
  });
});
