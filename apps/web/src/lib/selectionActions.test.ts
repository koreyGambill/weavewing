import { describe, expect, it } from "vite-plus/test";

import { resolveSelectionMenuPlacement } from "./selectionActions";

const line = (top: number, left = 100, right = 400) => ({
  left,
  right,
  top,
  bottom: top + 20,
});

const base = {
  firstLine: line(300),
  lastLine: line(340),
  bounds: { left: 0, top: 50, right: 1000, bottom: 800 },
  viewport: { width: 1000, height: 800 },
  columnSize: { width: 90, height: 60 },
  rowSize: { width: 160, height: 30 },
};

describe("resolveSelectionMenuPlacement", () => {
  it("puts a column in the margin beside the text when it fits", () => {
    expect(resolveSelectionMenuPlacement({ ...base, textColumn: { right: 700 } })).toEqual({
      orientation: "column",
      x: 712,
      y: 300,
    });
  });

  it("puts a row above the first selected line when the margin is too narrow", () => {
    expect(resolveSelectionMenuPlacement({ ...base, textColumn: { right: 950 } })).toEqual({
      orientation: "row",
      x: 100,
      y: 264,
    });
  });

  it("drops below the last selected line when there is no room above", () => {
    expect(
      resolveSelectionMenuPlacement({
        ...base,
        textColumn: { right: 950 },
        firstLine: line(60),
        lastLine: line(100),
      }),
    ).toEqual({ orientation: "row", x: 100, y: 126 });
  });
});
