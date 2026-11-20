import {
  getTileGroups,
  type TileGroup,
  type TileNode,
  type ThreadTileLayout,
} from "./threadTileLayout";

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function tileDropOrder<T extends { id: string }>(
  groups: readonly T[],
  focusedFloatingId: string | null,
): T[] {
  return groups
    .toReversed()
    .sort((a, b) => Number(b.id === focusedFloatingId) - Number(a.id === focusedFloatingId));
}

/** The maximized tile, beside its pair when one is chosen, or the whole docked tree. */
export function displayTileRoot(layout: ThreadTileLayout): TileNode {
  const groups = getTileGroups(layout);
  const docked = (id: string | null | undefined): TileGroup | undefined => {
    const group = groups.find((entry) => entry.id === id);
    if (!group) return undefined;
    const { floating: _floating, ...rest } = group;
    return rest;
  };
  const maximized = docked(layout.maximizedGroupId);
  if (!maximized) return layout.root;
  const beside = docked(layout.besideGroupId);
  return beside
    ? {
        kind: "split",
        id: "focus-pair-split",
        axis: "horizontal",
        ratio: layout.focusPairRatio ?? 0.5,
        first: maximized,
        second: beside,
      }
    : maximized;
}

/** Every tile on screen: the displayed tree plus floating tiles that hover above a zoomed view. */
export function visibleTileGroups(layout: ThreadTileLayout): TileGroup[] {
  if (!layout.maximizedGroupId) return getTileGroups(layout);
  return [
    ...getTileGroups(displayTileRoot(layout)),
    ...getTileGroups(layout).filter(
      (group) =>
        group.floating && group.id !== layout.maximizedGroupId && group.id !== layout.besideGroupId,
    ),
  ];
}

export function tileGeometry(root: TileNode) {
  const groups: Array<{ id: string; rect: TileRect }> = [];
  const splits: Array<{
    id: string;
    axis: "horizontal" | "vertical";
    ratio: number;
    rect: TileRect;
  }> = [];
  const visit = (node: TileNode, rect: TileRect) => {
    if (node.kind === "group") {
      groups.push({ id: node.id, rect });
      return;
    }
    splits.push({ id: node.id, axis: node.axis, ratio: node.ratio, rect });
    if (node.axis === "horizontal") {
      visit(node.first, { ...rect, width: rect.width * node.ratio });
      visit(node.second, {
        ...rect,
        x: rect.x + rect.width * node.ratio,
        width: rect.width * (1 - node.ratio),
      });
    } else {
      visit(node.first, { ...rect, height: rect.height * node.ratio });
      visit(node.second, {
        ...rect,
        y: rect.y + rect.height * node.ratio,
        height: rect.height * (1 - node.ratio),
      });
    }
  };
  visit(root, { x: 0, y: 0, width: 1, height: 1 });
  return { groups, splits };
}

/** Among equally near neighbors that share an edge, prefer the most recently focused. */
export function directionalTile(
  groups: readonly { id: string; rect: TileRect }[],
  currentId: string,
  direction: "left" | "right" | "up" | "down",
  recentIds: readonly string[] = [],
) {
  const current = groups.find((group) => group.id === currentId);
  if (!current) return null;
  const horizontal = direction === "left" || direction === "right";
  const reverse = direction === "left" || direction === "up";
  const currentStart = horizontal ? current.rect.x : current.rect.y;
  const currentSize = horizontal ? current.rect.width : current.rect.height;
  const currentCrossStart = horizontal ? current.rect.y : current.rect.x;
  const currentCrossSize = horizontal ? current.rect.height : current.rect.width;
  const rankById = new Map(recentIds.map((id, rank) => [id, rank]));
  let best: { id: string; overlap: boolean; gap: number; rank: number; cross: number } | null =
    null;
  for (const group of groups) {
    if (group.id === currentId) continue;
    const start = horizontal ? group.rect.x : group.rect.y;
    const size = horizontal ? group.rect.width : group.rect.height;
    const gap = reverse ? currentStart - start - size : start - currentStart - currentSize;
    if (gap < -1e-9) continue;
    const crossStart = horizontal ? group.rect.y : group.rect.x;
    const crossSize = horizontal ? group.rect.height : group.rect.width;
    const overlap =
      Math.min(currentCrossStart + currentCrossSize, crossStart + crossSize) -
        Math.max(currentCrossStart, crossStart) >
      1e-9;
    const cross = Math.abs(crossStart + crossSize / 2 - currentCrossStart - currentCrossSize / 2);
    const rank = overlap ? (rankById.get(group.id) ?? Infinity) : Infinity;
    const candidate = { id: group.id, overlap, gap: Math.max(0, gap), rank, cross };
    if (
      !best ||
      (candidate.overlap && !best.overlap) ||
      (candidate.overlap === best.overlap &&
        (candidate.gap < best.gap ||
          (candidate.gap === best.gap &&
            (candidate.rank < best.rank ||
              (candidate.rank === best.rank &&
                (candidate.cross < best.cross ||
                  (candidate.cross === best.cross && candidate.id < best.id)))))))
    )
      best = candidate;
  }
  return best?.id ?? null;
}

export type TileResizeSplit = ReturnType<typeof tileGeometry>["splits"][number];

export function resizeTileSplits(
  root: TileNode,
  groupId: string,
  pointer: { x: number; y: number },
) {
  const { groups, splits } = tileGeometry(root);
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) return [];
  const center = {
    x: group.rect.x + group.rect.width / 2,
    y: group.rect.y + group.rect.height / 2,
  };
  const borders = splits.filter((split) => {
    const rect = split.rect;
    if (
      center.x <= rect.x ||
      center.x >= rect.x + rect.width ||
      center.y <= rect.y ||
      center.y >= rect.y + rect.height
    )
      return false;
    const divider =
      split.axis === "horizontal"
        ? rect.x + rect.width * split.ratio
        : rect.y + rect.height * split.ratio;
    const start = split.axis === "horizontal" ? group.rect.x : group.rect.y;
    const size = split.axis === "horizontal" ? group.rect.width : group.rect.height;
    return Math.abs(divider - start) < 1e-9 || Math.abs(divider - start - size) < 1e-9;
  });
  return (["horizontal", "vertical"] as const).flatMap((axis) => {
    let nearest: TileResizeSplit | undefined;
    let distance = Infinity;
    for (const split of borders) {
      if (split.axis !== axis) continue;
      const divider =
        axis === "horizontal"
          ? split.rect.x + split.rect.width * split.ratio
          : split.rect.y + split.rect.height * split.ratio;
      const nextDistance = Math.abs((axis === "horizontal" ? pointer.x : pointer.y) - divider);
      if (nextDistance < distance) {
        nearest = split;
        distance = nextDistance;
      }
    }
    return nearest ? [nearest] : [];
  });
}

export function resizeTileRatio(split: TileResizeSplit, delta: { x: number; y: number }) {
  const distance = split.axis === "horizontal" ? delta.x : delta.y;
  const size = split.axis === "horizontal" ? split.rect.width : split.rect.height;
  return Number.isFinite(distance) && size > 0
    ? Math.max(0.1, Math.min(0.9, split.ratio + distance / size))
    : split.ratio;
}
