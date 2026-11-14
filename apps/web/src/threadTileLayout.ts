import type { TileLayoutArea } from "@t3tools/contracts";

export const CONVERSATION_TAB_ID = "conversation";
const NEW_TAB_PREFIX = "new-tab:";
/** An empty tab that shows the area chooser until an area replaces it. */
export const newTabId = (id: string) => `${NEW_TAB_PREFIX}${id}`;
export const isNewTab = (tabId: string) => tabId.startsWith(NEW_TAB_PREFIX);

const SURFACE_AREAS: Record<string, TileLayoutArea> = {
  browser: "browser",
  terminal: "terminal",
  files: "files",
  notes: "notes",
  diff: "diff",
  "pull-requests": "pull-requests",
};
/** The saved-layout area a surface id belongs to; surfaces that need a target have none. */
export const surfaceTileArea = (surfaceId: string): TileLayoutArea | null =>
  SURFACE_AREAS[surfaceId.split(":")[0]!] ?? null;

/** Puts tabs where a chosen new tab sat, or after the group's other tabs. */
function placeTabs(group: TileGroup, tabIds: string[]): TileGroup {
  const tabs = isNewTab(group.activeTabId)
    ? group.tabs.flatMap((id) => (id === group.activeTabId ? tabIds : [id]))
    : [...group.tabs, ...tabIds];
  return { ...group, tabs, activeTabId: tabIds[0] ?? group.activeTabId };
}

export type FloatingTileRect = { x: number; y: number; width: number; height: number };

export function boundFloatingTile(rect: FloatingTileRect): FloatingTileRect {
  const width = Math.max(0.2, Math.min(1, rect.width));
  const height = Math.max(0.2, Math.min(1, rect.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(1 - width, rect.x)),
    y: Math.max(0, Math.min(1 - height, rect.y)),
  };
}

export type FloatingTileEdges = { left?: true; right?: true; top?: true; bottom?: true };

/** Moves the dragged edges by `delta` while the opposite edges stay put. */
export function resizeFloatingTile(
  rect: FloatingTileRect,
  edges: FloatingTileEdges,
  delta: { x: number; y: number },
): FloatingTileRect {
  const min = 0.2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const left = edges.left ? Math.max(0, Math.min(right - min, rect.x + delta.x)) : rect.x;
  const top = edges.top ? Math.max(0, Math.min(bottom - min, rect.y + delta.y)) : rect.y;
  const nextRight = edges.right ? Math.min(1, Math.max(left + min, right + delta.x)) : right;
  const nextBottom = edges.bottom ? Math.min(1, Math.max(top + min, bottom + delta.y)) : bottom;
  return { x: left, y: top, width: nextRight - left, height: nextBottom - top };
}

export const DEFAULT_FLOATING_TILE: FloatingTileRect = {
  x: 0.15,
  y: 0.12,
  width: 0.65,
  height: 0.7,
};

export type TileGroup = {
  kind: "group";
  id: string;
  tabs: string[];
  activeTabId: string;
  colorIndex?: number;
  floating?: FloatingTileRect;
  /** Where the tile floated last, so floating it again puts it back there. */
  lastFloating?: FloatingTileRect;
};
export type TileSplit = {
  kind: "split";
  id: string;
  axis: "horizontal" | "vertical";
  ratio: number;
  first: TileNode;
  second: TileNode;
};
export type TileNode = TileGroup | TileSplit;
export type ThreadTileLayout = {
  root: TileNode;
  focusedGroupId: string;
  maximizedGroupId: string | null;
  /** Shown to the right of the maximized tile; only meaningful while one is maximized. */
  besideGroupId?: string | null;
  focusPairRatio?: number;
  /** Placeholder tabs from a saved layout, keyed by tab id, waiting for their area to open. */
  pendingAreas?: Record<string, TileLayoutArea>;
};
export type TileAction =
  | { type: "float-group"; groupId: string; rect: FloatingTileRect }
  | { type: "restore-group"; groupId: string }
  | { type: "show-beside"; groupId: string | null }
  | { type: "swap-beside" }
  | { type: "resize-focus-pair"; ratio: number }
  | { type: "activate"; groupId: string; tabId: string }
  | { type: "focus"; groupId: string }
  | { type: "move"; tabId: string; targetGroupId: string; index?: number }
  | {
      type: "split";
      tabId: string;
      targetGroupId: string;
      axis: "horizontal" | "vertical";
      side: "before" | "after";
      groupId: string;
      splitId: string;
    }
  | {
      type: "new-group";
      targetGroupId: string;
      axis: "horizontal" | "vertical";
      side: "before" | "after";
      groupId: string;
      splitId: string;
    }
  | { type: "close-group"; groupId: string }
  | { type: "close-tab"; tabId: string }
  | { type: "new-tab"; groupId: string; tabId: string }
  | { type: "merge-groups"; groupId: string; targetGroupId: string }
  | { type: "swap-groups"; firstGroupId: string; secondGroupId: string }
  | {
      type: "dock-group";
      groupId: string;
      targetGroupId: string;
      axis: "horizontal" | "vertical";
      side: "before" | "after";
      splitId: string;
    }
  | { type: "resize"; splitId: string; ratio: number }
  | { type: "maximize"; groupId: string | null };

export function getTileGroups(layout: ThreadTileLayout | TileNode): TileGroup[] {
  const node = "root" in layout ? layout.root : layout;
  return node.kind === "group"
    ? [node]
    : [...getTileGroups(node.first), ...getTileGroups(node.second)];
}

function mapNode(node: TileNode, transform: (node: TileNode) => TileNode): TileNode {
  return transform(
    node.kind === "group"
      ? node
      : { ...node, first: mapNode(node.first, transform), second: mapNode(node.second, transform) },
  );
}

function removeGroup(node: TileNode, groupId: string): TileNode | null {
  if (node.kind === "group") return node.id === groupId ? null : node;
  const first = removeGroup(node.first, groupId);
  const second = removeGroup(node.second, groupId);
  return first && second ? { ...node, first, second } : (first ?? second);
}

function prune(
  node: TileNode,
  valid: Set<string>,
  emptyGroupIds: Set<string>,
  seen = new Set<string>(),
): TileNode | null {
  if (node.kind === "group") {
    const tabs = node.tabs.filter((id) => {
      if ((!valid.has(id) && !isNewTab(id)) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const activeIndex = node.tabs.indexOf(node.activeTabId);
    return tabs.length || emptyGroupIds.has(node.id)
      ? {
          ...node,
          tabs,
          activeTabId: tabs.includes(node.activeTabId)
            ? node.activeTabId
            : (node.tabs.slice(activeIndex + 1).find((id) => tabs.includes(id)) ??
              tabs.at(-1) ??
              ""),
        }
      : null;
  }
  const first = prune(node.first, valid, emptyGroupIds, seen);
  const second = prune(node.second, valid, emptyGroupIds, seen);
  return first && second ? { ...node, first, second } : (first ?? second);
}

function settle(input: ThreadTileLayout): ThreadTileLayout {
  // Floating tiles hover over the docked ones, so at least one tile stays docked.
  const { floating, ...firstGroup } = getTileGroups(input)[0]!;
  const layout =
    floating && getTileGroups(input).every((group) => group.floating)
      ? {
          ...input,
          root: mapNode(input.root, (node) =>
            node.id === firstGroup.id ? { ...firstGroup, lastFloating: floating } : node,
          ),
        }
      : input;
  const groups = getTileGroups(layout);
  const occupiedColors = new Set(
    groups.flatMap((group) => (group.colorIndex !== undefined ? [group.colorIndex] : [])),
  );
  let recycledColor = 0;
  const root = mapNode(layout.root, (node) => {
    if (node.kind !== "group" || node.colorIndex !== undefined) return node;
    const colorIndex =
      Array.from({ length: 8 }, (_, index) => index).find((index) => !occupiedColors.has(index)) ??
      recycledColor++ % 8;
    occupiedColors.add(colorIndex);
    return { ...node, colorIndex };
  });
  const ids = new Set(groups.map((group) => group.id));
  const maximizedGroupId =
    layout.maximizedGroupId && ids.has(layout.maximizedGroupId) ? layout.maximizedGroupId : null;
  const besideGroupId =
    maximizedGroupId &&
    layout.besideGroupId &&
    layout.besideGroupId !== maximizedGroupId &&
    ids.has(layout.besideGroupId)
      ? layout.besideGroupId
      : null;
  const { besideGroupId: _beside, ...rest } = layout;
  return {
    ...rest,
    root,
    ...(besideGroupId ? { besideGroupId } : {}),
    focusedGroupId: ids.has(layout.focusedGroupId)
      ? layout.focusedGroupId
      : (maximizedGroupId ?? groups[0]!.id),
    maximizedGroupId,
  };
}

/** The tab its group shows after `tabId` closes, so focus stays in the group the user closed from. */
export function tileCloseFallback(layout: ThreadTileLayout | undefined, tabId: string) {
  const tabs = layout && getTileGroups(layout).find((group) => group.tabs.includes(tabId))?.tabs;
  if (!tabs) return null;
  const index = tabs.indexOf(tabId);
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

export function syncTileLayout(
  layout: ThreadTileLayout | undefined,
  previousSurfaceIds: string[],
  surfaceIds: string[],
  activeSurfaceId: string | null,
  activate: boolean,
  /** False for surfaces opened by code, which must not fill a tile the user is choosing for. */
  fillChooser = true,
): ThreadTileLayout {
  if (!layout) {
    const conversation: TileGroup = {
      kind: "group",
      id: "conversation-group",
      colorIndex: 0,
      tabs: [CONVERSATION_TAB_ID],
      activeTabId: CONVERSATION_TAB_ID,
    };
    if (!surfaceIds.length)
      return { root: conversation, focusedGroupId: conversation.id, maximizedGroupId: null };
    const panels: TileGroup = {
      kind: "group",
      id: "panels-group",
      colorIndex: 1,
      tabs: [...surfaceIds],
      activeTabId: surfaceIds.includes(activeSurfaceId ?? "") ? activeSurfaceId! : surfaceIds[0]!,
    };
    return {
      root: {
        kind: "split",
        id: "initial-split",
        axis: "horizontal",
        ratio: 0.55,
        first: conversation,
        second: panels,
      },
      focusedGroupId: panels.id,
      maximizedGroupId: null,
    };
  }
  const valid = new Set([CONVERSATION_TAB_ID, ...surfaceIds]);
  const emptyGroupIds = new Set(
    getTileGroups(layout)
      .filter((group) => !group.tabs.length)
      .map((group) => group.id),
  );
  const root = prune(layout.root, valid, emptyGroupIds) ?? {
    kind: "group",
    id: "root-group",
    tabs: [],
    activeTabId: "",
  };
  const placedIds = new Set(getTileGroups(root).flatMap((group) => group.tabs));
  let next = fillPendingAreas(
    settle({ ...layout, root }),
    surfaceIds.filter((id) => !placedIds.has(id)),
  );
  const showsChooser = (group: TileGroup) => !group.tabs.length || isNewTab(group.activeTabId);
  if (
    fillChooser &&
    activate &&
    activeSurfaceId &&
    surfaceIds.includes(activeSurfaceId) &&
    getTileGroups(next).some((group) => group.id === next.focusedGroupId && showsChooser(group))
  ) {
    next = applyTileAction(next, {
      type: "move",
      tabId: activeSurfaceId,
      targetGroupId: next.focusedGroupId,
    });
  }
  const present = new Set(getTileGroups(next).flatMap((group) => group.tabs));
  const missing = surfaceIds.filter((id) => !present.has(id));
  if (missing.length) {
    const groups = getTileGroups(next);
    const focused = groups.find((group) => group.id === next.focusedGroupId)!;
    const target =
      fillChooser || !showsChooser(focused)
        ? focused
        : (groups.find((group) => !showsChooser(group)) ?? focused);
    next = {
      ...next,
      root: mapNode(next.root, (node) =>
        node.kind === "group" && node.id === target.id
          ? fillChooser && isNewTab(node.activeTabId)
            ? placeTabs(node, missing)
            : { ...node, tabs: [...node.tabs, ...missing] }
          : node,
      ),
    };
  }
  // A close falls back to another surface, which must not switch the tab another group shows.
  const closedSurface = previousSurfaceIds.some((id) => !surfaceIds.includes(id));
  if (
    activate &&
    activeSurfaceId &&
    !(closedSurface && previousSurfaceIds.includes(activeSurfaceId)) &&
    (surfaceIds.includes(activeSurfaceId) || !previousSurfaceIds.includes(activeSurfaceId))
  ) {
    const owner = getTileGroups(next).find((group) => group.tabs.includes(activeSurfaceId));
    if (owner)
      next = applyTileAction(next, { type: "activate", groupId: owner.id, tabId: activeSurfaceId });
  }
  return next;
}

/** Puts new surfaces in the placeholders waiting for their area and forgets closed placeholders. */
function fillPendingAreas(layout: ThreadTileLayout, newSurfaceIds: string[]): ThreadTileLayout {
  if (!layout.pendingAreas) return layout;
  const { pendingAreas: _pending, ...rest } = layout;
  const placed = new Map<string, string>();
  for (const surfaceId of newSurfaceIds) {
    const placeholder = Object.keys(layout.pendingAreas).find(
      (tabId) => !placed.has(tabId) && layout.pendingAreas![tabId] === surfaceTileArea(surfaceId),
    );
    if (placeholder) placed.set(placeholder, surfaceId);
  }
  const root = placed.size
    ? mapNode(layout.root, (node) =>
        node.kind === "group" && node.tabs.some((id) => placed.has(id))
          ? {
              ...node,
              tabs: node.tabs.map((id) => placed.get(id) ?? id),
              activeTabId: placed.get(node.activeTabId) ?? node.activeTabId,
            }
          : node,
      )
    : layout.root;
  const present = new Set(getTileGroups(root).flatMap((group) => group.tabs));
  const pending = Object.fromEntries(
    Object.entries(layout.pendingAreas).filter(([tabId]) => present.has(tabId)),
  );
  return { ...rest, root, ...(Object.keys(pending).length ? { pendingAreas: pending } : {}) };
}

export function applyTileAction(layout: ThreadTileLayout, action: TileAction): ThreadTileLayout {
  const groups = getTileGroups(layout);
  const zoomed = (group: TileGroup) =>
    Boolean(group.floating) ||
    group.id === layout.maximizedGroupId ||
    group.id === layout.besideGroupId;
  if (action.type === "float-group" || action.type === "restore-group") {
    if (!groups.some((group) => group.id === action.groupId)) return layout;
    const target = groups.find((group) => group.id === action.groupId)!;
    if (action.type === "float-group") {
      if (!Object.values(action.rect).every(Number.isFinite)) return layout;
      // The last docked tile stays docked; floating tiles hover over the docked ones.
      if (!target.floating && groups.filter((group) => !group.floating).length < 2) return layout;
    }
    return settle({
      ...layout,
      root: mapNode(layout.root, (node) => {
        if (node.kind !== "group" || node.id !== action.groupId) return node;
        const { floating, lastFloating: _lastFloating, ...group } = node;
        return action.type === "float-group"
          ? { ...group, floating: boundFloatingTile(action.rect) }
          : { ...group, ...(floating ? { lastFloating: floating } : {}) };
      }),
      focusedGroupId: action.groupId,
      // Moving a floating tile keeps the maximized view it hovers over.
      maximizedGroupId:
        action.type === "float-group" && target.floating ? layout.maximizedGroupId : null,
    });
  }
  if (action.type === "show-beside") {
    if (action.groupId === null) return settle({ ...layout, besideGroupId: null });
    if (
      !layout.maximizedGroupId ||
      action.groupId === layout.maximizedGroupId ||
      !groups.some((group) => group.id === action.groupId)
    )
      return layout;
    return { ...layout, besideGroupId: action.groupId, focusedGroupId: action.groupId };
  }
  if (action.type === "swap-beside")
    return layout.maximizedGroupId && layout.besideGroupId
      ? {
          ...layout,
          maximizedGroupId: layout.besideGroupId,
          besideGroupId: layout.maximizedGroupId,
        }
      : layout;
  if (action.type === "resize-focus-pair")
    return Number.isFinite(action.ratio)
      ? { ...layout, focusPairRatio: Math.min(0.9, Math.max(0.1, action.ratio)) }
      : layout;
  if (action.type === "maximize") {
    const group = groups.find((entry) => entry.id === action.groupId);
    return settle({
      ...layout,
      besideGroupId: null,
      maximizedGroupId: group?.id ?? null,
      focusedGroupId: group?.id ?? layout.focusedGroupId,
    });
  }
  if (action.type === "resize")
    return Number.isFinite(action.ratio)
      ? {
          ...layout,
          root: mapNode(layout.root, (node) =>
            node.kind === "split" && node.id === action.splitId
              ? { ...node, ratio: Math.min(0.9, Math.max(0.1, action.ratio)) }
              : node,
          ),
        }
      : layout;
  if (action.type === "focus" || action.type === "activate") {
    const group = groups.find((entry) => entry.id === action.groupId);
    if (!group || (action.type === "activate" && !group.tabs.includes(action.tabId))) return layout;
    return settle({
      ...layout,
      focusedGroupId: group.id,
      ...(zoomed(group) ? {} : { maximizedGroupId: null }),
      root:
        action.type === "activate"
          ? mapNode(layout.root, (node) =>
              node.id === group.id && node.kind === "group"
                ? { ...node, activeTabId: action.tabId }
                : node,
            )
          : layout.root,
    });
  }
  if (action.type === "close-group") {
    const group = groups.find((entry) => entry.id === action.groupId);
    if (!group || (groups.length === 1 && !group.tabs.length)) return layout;
    const root = removeGroup(layout.root, group.id);
    return settle({
      ...layout,
      root: root ?? { kind: "group", id: group.id, tabs: [], activeTabId: "" },
      focusedGroupId: root ? layout.focusedGroupId : group.id,
      maximizedGroupId: null,
    });
  }
  if (action.type === "new-tab") {
    const group = groups.find((entry) => entry.id === action.groupId);
    if (
      !group ||
      !isNewTab(action.tabId) ||
      groups.some((entry) => entry.tabs.includes(action.tabId))
    )
      return layout;
    return settle({
      ...layout,
      root: mapNode(layout.root, (node) =>
        node.id === group.id
          ? { ...group, tabs: [...group.tabs, action.tabId], activeTabId: action.tabId }
          : node,
      ),
      focusedGroupId: group.id,
    });
  }
  if (action.type === "close-tab") {
    const owner = groups.find((group) => group.tabs.includes(action.tabId));
    if (!owner) return layout;
    const tabs = owner.tabs.filter((id) => id !== action.tabId);
    if (!tabs.length) return applyTileAction(layout, { type: "close-group", groupId: owner.id });
    const activeTabId =
      owner.activeTabId === action.tabId
        ? tileCloseFallback(layout, action.tabId)!
        : owner.activeTabId;
    return settle({
      ...layout,
      root: mapNode(layout.root, (node) =>
        node.id === owner.id ? { ...owner, tabs, activeTabId } : node,
      ),
    });
  }
  if (action.type === "new-group") {
    if (
      !groups.some((group) => group.id === action.targetGroupId) ||
      !action.groupId ||
      !action.splitId ||
      action.groupId === action.splitId
    )
      return layout;
    let conflictingId = false;
    mapNode(layout.root, (node) => {
      if (node.id === action.groupId || node.id === action.splitId) conflictingId = true;
      return node;
    });
    if (conflictingId) return layout;
    const added: TileGroup = { kind: "group", id: action.groupId, tabs: [], activeTabId: "" };
    return settle({
      ...layout,
      root: mapNode(layout.root, (node) =>
        node.id === action.targetGroupId
          ? {
              kind: "split",
              id: action.splitId,
              axis: action.axis,
              ratio: 0.5,
              first: action.side === "before" ? added : node,
              second: action.side === "before" ? node : added,
            }
          : node,
      ),
      focusedGroupId: added.id,
      maximizedGroupId: null,
    });
  }
  if (action.type === "merge-groups") {
    const source = groups.find((group) => group.id === action.groupId);
    const target = groups.find((group) => group.id === action.targetGroupId);
    if (!source?.tabs.length || !target || source.id === target.id) return layout;
    return settle({
      ...layout,
      root: mapNode(removeGroup(layout.root, source.id)!, (node) =>
        node.kind === "group" && node.id === target.id
          ? { ...node, tabs: [...node.tabs, ...source.tabs], activeTabId: source.activeTabId }
          : node,
      ),
      focusedGroupId: target.id,
      maximizedGroupId: null,
    });
  }
  if (action.type === "swap-groups") {
    const first = groups.find((group) => group.id === action.firstGroupId);
    const second = groups.find((group) => group.id === action.secondGroupId);
    if (!first || !second || first.id === second.id) return layout;
    return settle({
      ...layout,
      root: mapNode(layout.root, (node) =>
        node.id === first.id ? second : node.id === second.id ? first : node,
      ),
      focusedGroupId: first.id,
      maximizedGroupId: null,
    });
  }
  if (action.type === "dock-group") {
    const source = groups.find((group) => group.id === action.groupId);
    const target = groups.find((group) => group.id === action.targetGroupId);
    if (!source || !target || source.id === target.id || !action.splitId) return layout;
    let conflictingId = false;
    mapNode(layout.root, (node) => {
      if (node.id === action.splitId) conflictingId = true;
      return node;
    });
    if (conflictingId) return layout;
    const remaining = removeGroup(layout.root, source.id)!;
    const { floating: _floating, ...dockedSource } = source;
    return settle({
      ...layout,
      root: mapNode(remaining, (node) =>
        node.id === target.id
          ? {
              kind: "split",
              id: action.splitId,
              axis: action.axis,
              ratio: 0.5,
              first: action.side === "before" ? dockedSource : node,
              second: action.side === "before" ? node : dockedSource,
            }
          : node,
      ),
      focusedGroupId: source.id,
      maximizedGroupId: null,
    });
  }
  const target = groups.find((group) => group.id === action.targetGroupId);
  if (
    target &&
    action.type === "move" &&
    action.tabId === CONVERSATION_TAB_ID &&
    !groups.some((group) => group.tabs.includes(CONVERSATION_TAB_ID))
  )
    return settle({
      ...layout,
      root: mapNode(layout.root, (node) =>
        node.id === target.id && node.kind === "group"
          ? placeTabs(node, [CONVERSATION_TAB_ID])
          : node,
      ),
      focusedGroupId: target.id,
      maximizedGroupId: null,
    });
  const source = groups.find((group) => group.tabs.includes(action.tabId));
  if (!source || !target) return layout;
  if (action.type === "split" && source.id === target.id && source.tabs.length === 1) return layout;
  if (action.type === "split") {
    const ids = new Set<string>();
    mapNode(layout.root, (node) => {
      ids.add(node.id);
      return node;
    });
    if (ids.has(action.groupId) || ids.has(action.splitId) || action.groupId === action.splitId)
      return layout;
  }
  let root = mapNode(layout.root, (node) => {
    if (node.kind !== "group") return node;
    const replaced =
      action.type === "move" &&
      node.id === target.id &&
      isNewTab(node.activeTabId) &&
      node.activeTabId !== action.tabId
        ? node.activeTabId
        : null;
    const index = replaced
      ? node.tabs.indexOf(replaced)
      : action.type === "move"
        ? (action.index ?? node.tabs.length)
        : node.tabs.length;
    const tabs = node.tabs.filter((id) => id !== action.tabId && id !== replaced);
    if (action.type === "move" && node.id === target.id)
      tabs.splice(Math.min(tabs.length, Math.max(0, index)), 0, action.tabId);
    const group = {
      ...node,
      tabs,
      activeTabId:
        node.id === target.id && action.type === "move"
          ? action.tabId
          : tabs.includes(node.activeTabId)
            ? node.activeTabId
            : (tabs[0] ?? ""),
    };
    if (action.type !== "split" || node.id !== target.id) return group;
    const added: TileGroup = {
      kind: "group",
      id: action.groupId,
      tabs: [action.tabId],
      activeTabId: action.tabId,
    };
    return {
      kind: "split",
      id: action.splitId,
      axis: action.axis,
      ratio: 0.5,
      first: action.side === "before" ? added : group,
      second: action.side === "before" ? group : added,
    };
  });
  root = prune(
    root,
    new Set(groups.flatMap((group) => group.tabs)),
    new Set(groups.filter((group) => !group.tabs.length).map((group) => group.id)),
  )!;
  return settle({
    ...layout,
    root,
    focusedGroupId: action.type === "split" ? action.groupId : target.id,
    maximizedGroupId: null,
  });
}

function parseFloatingRect(raw: unknown): FloatingTileRect | undefined {
  return raw &&
    typeof raw === "object" &&
    "x" in raw &&
    typeof raw.x === "number" &&
    "y" in raw &&
    typeof raw.y === "number" &&
    "width" in raw &&
    typeof raw.width === "number" &&
    "height" in raw &&
    typeof raw.height === "number" &&
    [raw.x, raw.y, raw.width, raw.height].every(Number.isFinite)
    ? boundFloatingTile({ x: raw.x, y: raw.y, width: raw.width, height: raw.height })
    : undefined;
}

export function parseTileLayout(value: unknown): ThreadTileLayout | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("root" in value) ||
    !("focusedGroupId" in value) ||
    typeof value.focusedGroupId !== "string"
  )
    return undefined;
  const ids = new Set<string>();
  let count = 0;
  const parse = (raw: unknown, depth: number): TileNode | null => {
    if (
      !raw ||
      typeof raw !== "object" ||
      depth > 32 ||
      ++count > 255 ||
      !("id" in raw) ||
      typeof raw.id !== "string" ||
      !raw.id ||
      ids.has(raw.id) ||
      !("kind" in raw)
    )
      return null;
    ids.add(raw.id);
    if (raw.kind === "group") {
      if (
        !("tabs" in raw) ||
        !Array.isArray(raw.tabs) ||
        raw.tabs.length > 1024 ||
        !raw.tabs.every((id): id is string => typeof id === "string") ||
        !("activeTabId" in raw) ||
        typeof raw.activeTabId !== "string" ||
        (!raw.tabs.length && raw.activeTabId !== "")
      )
        return null;
      return {
        kind: "group",
        id: raw.id,
        ...("floating" in raw && parseFloatingRect(raw.floating)
          ? { floating: parseFloatingRect(raw.floating)! }
          : {}),
        ...("lastFloating" in raw && parseFloatingRect(raw.lastFloating)
          ? { lastFloating: parseFloatingRect(raw.lastFloating)! }
          : {}),
        tabs: raw.tabs,
        activeTabId: raw.activeTabId,
        ...("colorIndex" in raw &&
        typeof raw.colorIndex === "number" &&
        Number.isInteger(raw.colorIndex) &&
        raw.colorIndex >= 0 &&
        raw.colorIndex < 8
          ? { colorIndex: raw.colorIndex }
          : {}),
      };
    }
    if (
      raw.kind !== "split" ||
      !("axis" in raw) ||
      (raw.axis !== "horizontal" && raw.axis !== "vertical") ||
      !("ratio" in raw) ||
      typeof raw.ratio !== "number" ||
      !Number.isFinite(raw.ratio) ||
      !("first" in raw) ||
      !("second" in raw)
    )
      return null;
    const first = parse(raw.first, depth + 1);
    const second = parse(raw.second, depth + 1);
    return first && second
      ? {
          kind: "split",
          id: raw.id,
          axis: raw.axis,
          ratio: Math.min(0.9, Math.max(0.1, raw.ratio)),
          first,
          second,
        }
      : null;
  };
  const root = parse(value.root, 0);
  return root
    ? settle({
        root,
        ...("besideGroupId" in value && typeof value.besideGroupId === "string"
          ? { besideGroupId: value.besideGroupId }
          : {}),
        ...("focusPairRatio" in value &&
        typeof value.focusPairRatio === "number" &&
        Number.isFinite(value.focusPairRatio)
          ? { focusPairRatio: Math.min(0.9, Math.max(0.1, value.focusPairRatio)) }
          : {}),
        ...("pendingAreas" in value && value.pendingAreas && typeof value.pendingAreas === "object"
          ? {
              pendingAreas: Object.fromEntries(
                Object.entries(value.pendingAreas).filter(
                  ([tabId, area]) =>
                    isNewTab(tabId) &&
                    typeof area === "string" &&
                    Object.values(SURFACE_AREAS).includes(area as TileLayoutArea),
                ),
              ) as Record<string, TileLayoutArea>,
            }
          : {}),
        focusedGroupId: value.focusedGroupId,
        maximizedGroupId:
          "maximizedGroupId" in value && typeof value.maximizedGroupId === "string"
            ? value.maximizedGroupId
            : null,
      })
    : undefined;
}
