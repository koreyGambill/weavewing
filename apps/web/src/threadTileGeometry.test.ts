import { describe, expect, it } from "vite-plus/test";
import {
  displayTileRoot,
  directionalTile,
  tileGeometry,
  resizeTileSplits,
  resizeTileRatio,
  tileDropOrder,
} from "./threadTileGeometry";
import { syncTileLayout, applyTileAction, getTileGroups, type TileNode } from "./threadTileLayout";

describe("tile geometry", () => {
  it("hit-tests the focused floating tile above later overlapping tiles", () => {
    const groups = [{ id: "docked" }, { id: "front" }, { id: "back" }];
    expect(tileDropOrder(groups, "front").map((group) => group.id)).toEqual([
      "front",
      "back",
      "docked",
    ]);
    expect(tileDropOrder(groups, null).map((group) => group.id)).toEqual([
      "back",
      "front",
      "docked",
    ]);
  });
  it("covers nested splits and navigates to the nearest tile in each direction", () => {
    const group = (id: string): TileNode => ({ kind: "group", id, tabs: [id], activeTabId: id });
    const root: TileNode = {
      kind: "split",
      id: "columns",
      axis: "horizontal",
      ratio: 0.6,
      first: group("chat"),
      second: {
        kind: "split",
        id: "rows",
        axis: "vertical",
        ratio: 0.4,
        first: group("browser"),
        second: group("terminal"),
      },
    };
    const geometry = tileGeometry(root);
    expect(geometry.groups).toEqual([
      { id: "chat", rect: { x: 0, y: 0, width: 0.6, height: 1 } },
      { id: "browser", rect: { x: 0.6, y: 0, width: 0.4, height: 0.4 } },
      { id: "terminal", rect: { x: 0.6, y: 0.4, width: 0.4, height: 0.6 } },
    ]);
    expect(directionalTile(geometry.groups, "browser", "down")).toBe("terminal");
    expect(directionalTile(geometry.groups, "terminal", "left")).toBe("chat");
    expect(directionalTile(geometry.groups, "chat", "left")).toBeNull();
    expect(directionalTile(geometry.groups, "chat", "right")).toBe("terminal");
  });
  it("visits the adjacent middle column before the aligned far column in uneven seven-pane layouts", () => {
    const groups = [
      { id: "left-top", rect: { x: 0, y: 0, width: 1 / 3, height: 0.2 } },
      { id: "left-bottom", rect: { x: 0, y: 0.2, width: 1 / 3, height: 0.6 } },
      { id: "middle-top", rect: { x: 1 / 3, y: 0, width: 1 / 3, height: 0.7 } },
      { id: "middle-bottom", rect: { x: 1 / 3, y: 0.7, width: 1 / 3, height: 0.1 } },
      { id: "right-top", rect: { x: 2 / 3, y: 0, width: 1 / 3, height: 0.2 } },
      { id: "right-bottom", rect: { x: 2 / 3, y: 0.2, width: 1 / 3, height: 0.6 } },
      { id: "wide-bottom", rect: { x: 0, y: 0.8, width: 1, height: 0.2 } },
    ];
    const minimal = [groups[0]!, groups[2]!, groups[4]!];
    const aligned = minimal.map((group) =>
      group.id === "middle-top" ? { ...group, rect: { ...group.rect, height: 0.2 } } : group,
    );
    expect(directionalTile(aligned, "left-top", "right")).toBe("middle-top");
    expect(directionalTile(minimal.toReversed(), "left-top", "right")).toBe(
      directionalTile(minimal, "left-top", "right"),
    );
    expect(directionalTile(minimal, "left-top", "right")).toBe("middle-top");
    expect(directionalTile(groups, "left-top", "right")).toBe("middle-top");
    expect(directionalTile(groups, "right-top", "left")).toBe("middle-top");
    expect(directionalTile(groups, "middle-top", "right")).toBe("right-bottom");
    expect(directionalTile(groups, "left-bottom", "down")).toBe("wide-bottom");
    expect(directionalTile(groups, "left-top", "down")).toBe("left-bottom");
    const transposed = groups.map((group) => ({
      id: group.id,
      rect: {
        x: group.rect.y,
        y: group.rect.x,
        width: group.rect.height,
        height: group.rect.width,
      },
    }));
    expect(directionalTile(transposed, "left-top", "down")).toBe("middle-top");
    expect(directionalTile(transposed, "right-top", "up")).toBe("middle-top");
  });

  it("uses activation history at a shared edge and stays aligned in a grid", () => {
    const top = { id: "top", rect: { x: 0.5, y: 0, width: 0.5, height: 0.6 } };
    const bottom = { id: "bottom", rect: { x: 0.5, y: 0.6, width: 0.5, height: 0.4 } };
    const tall = { id: "tall", rect: { x: 0, y: 0, width: 0.5, height: 1 } };
    const stack = [top, bottom, tall];
    expect(directionalTile(stack, "bottom", "left")).toBe("tall");
    expect(directionalTile(stack, "tall", "right")).toBe("top");
    expect(directionalTile(stack, "tall", "right", ["tall", "bottom", "top"])).toBe("bottom");

    const upperLeft = { id: "upper-left", rect: { ...top.rect, x: 0 } };
    const lowerLeft = { id: "lower-left", rect: { ...bottom.rect, x: 0 } };
    expect(
      directionalTile([top, bottom, upperLeft, lowerLeft], "upper-left", "right", ["bottom"]),
    ).toBe("top");
  });

  it("does not treat a wide pane below as a horizontal neighbor", () => {
    const groups = [
      { id: "current", rect: { x: 0, y: 0, width: 0.3, height: 0.8 } },
      { id: "below", rect: { x: 0, y: 0.8, width: 1, height: 0.2 } },
    ];
    expect(directionalTile(groups, "current", "right")).toBeNull();
    expect(directionalTile(groups, "below", "left")).toBeNull();
    expect(directionalTile(groups, "current", "down")).toBe("below");
  });

  it("resizes only ancestor dividers bordering the focused tile and chooses the pointer's nearest edges", () => {
    const group = (id: string): TileNode => ({ kind: "group", id, tabs: [id], activeTabId: id });
    const root: TileNode = {
      kind: "split",
      id: "outer",
      axis: "horizontal",
      ratio: 0.2,
      first: group("left"),
      second: {
        kind: "split",
        id: "rows",
        axis: "vertical",
        ratio: 0.7,
        second: group("bottom"),
        first: {
          kind: "split",
          id: "inner",
          axis: "horizontal",
          ratio: 0.5,
          second: group("right"),
          first: {
            kind: "split",
            id: "near",
            axis: "horizontal",
            ratio: 0.5,
            first: group("middle"),
            second: group("focused"),
          },
        },
      },
    };
    const leftEdges = resizeTileSplits(root, "focused", { x: 0.41, y: 0.6 });
    expect(leftEdges.map((split) => split.id)).toEqual(["near", "rows"]);
    expect(leftEdges[0]).toMatchObject({
      ratio: 0.5,
      rect: { x: 0.2, y: 0, width: 0.4, height: 0.7 },
    });
    expect(resizeTileSplits(root, "focused", { x: 0.59, y: 0.6 }).map((split) => split.id)).toEqual(
      ["inner", "rows"],
    );
    const transpose = (node: TileNode): TileNode =>
      node.kind === "group"
        ? node
        : {
            ...node,
            axis: node.axis === "horizontal" ? "vertical" : "horizontal",
            first: transpose(node.first),
            second: transpose(node.second),
          };
    const transposedEdges = resizeTileSplits(transpose(root), "focused", { x: 0.6, y: 0.41 });
    expect(transposedEdges.map((split) => split.id)).toEqual(["rows", "near"]);
    expect(resizeTileRatio(transposedEdges[1]!, { x: 0, y: 0.04 })).toBeCloseTo(0.6);
    expect(
      resizeTileSplits(transpose(root), "focused", { x: 0.6, y: 0.59 }).map((split) => split.id),
    ).toEqual(["rows", "inner"]);
    expect(resizeTileSplits(root, "missing", { x: 0, y: 0 })).toEqual([]);
    expect(resizeTileSplits(group("only"), "only", { x: 0, y: 0 })).toEqual([]);
    expect(resizeTileRatio(leftEdges[0]!, { x: 0.04, y: 0 })).toBeCloseTo(0.6);
    expect(resizeTileRatio(leftEdges[1]!, { x: 0, y: -0.1 })).toBeCloseTo(0.6);
    expect(resizeTileRatio(leftEdges[0]!, { x: 1, y: 0 })).toBe(0.9);
    expect(resizeTileRatio(leftEdges[0]!, { x: -1, y: 0 })).toBe(0.1);
    expect(resizeTileRatio(leftEdges[0]!, { x: NaN, y: 0 })).toBe(0.5);
  });
  it("projects a maximized tile beside its pair, docked, without touching the real root", () => {
    let initial = syncTileLayout(undefined, [], ["files", "notes"], "files", true);
    initial = applyTileAction(initial, {
      type: "float-group",
      groupId: "panels-group",
      rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    });
    const maximized = applyTileAction(initial, { type: "maximize", groupId: "conversation-group" });
    expect(displayTileRoot(maximized)).toEqual(getTileGroups(initial)[0]);
    const paired = applyTileAction(maximized, { type: "show-beside", groupId: "panels-group" });
    const root = displayTileRoot(paired);
    expect(root).toMatchObject({ kind: "split", id: "focus-pair-split", ratio: 0.5 });
    expect(getTileGroups(root).map((group) => [group.id, group.floating])).toEqual([
      ["conversation-group", undefined],
      ["panels-group", undefined],
    ]);
    expect(paired.root).toBe(maximized.root);
    expect(
      resizeTileSplits(root, "conversation-group", { x: 0.45, y: 0.5 }).map((split) => split.id),
    ).toEqual(["focus-pair-split"]);
    expect(displayTileRoot(applyTileAction(paired, { type: "maximize", groupId: null }))).toEqual(
      initial.root,
    );
  });
});
