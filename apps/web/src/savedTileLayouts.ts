import type {
  ProjectId,
  SavedTileLayout,
  SavedTileNode,
  SavedTileViewNode,
  ServerSettings,
  ServerSettingsPatch,
  TileLayoutArea,
} from "@t3tools/contracts";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";

import {
  CONVERSATION_TAB_ID,
  getTileGroups,
  isNewTab,
  newTabId,
  surfaceTileArea,
  type ThreadTileLayout,
  type TileArea,
  type TileNode,
} from "./threadTileLayout";
import { storedViewId, VIEW_TITLES } from "./components/ToolSidebar.logic";
import { isViewArea, viewIdFromArea } from "./views/viewTiles.logic";

export const TILE_LAYOUT_AREA_LABELS = {
  device: "Device",
  "side-chat": "Side chat",
  "pull-request": "Pull request",
  chat: "Main chat",
  browser: "Browser",
  terminal: "Terminal",
  files: "Files",
  notes: "Notes",
  diff: "Diff",
  "pull-requests": "Pull requests",
} as const satisfies Record<TileLayoutArea, string>;

/** An area's name in layout menus and settings, or null for a view that no longer exists. */
export function tileLayoutAreaLabel(area: TileArea): string | null {
  if (!isViewArea(area)) return TILE_LAYOUT_AREA_LABELS[area];
  const viewId = viewIdFromArea(area);
  return viewId ? VIEW_TITLES[viewId] : null;
}

const tabArea = (tabId: string): TileArea | null =>
  tabId === CONVERSATION_TAB_ID ? "chat" : surfaceTileArea(tabId);

/** The docked tree as a saved layout; `dropped` reports tabs or tiles a layout cannot keep. */
export function toSavedTileNode(layout: ThreadTileLayout): {
  root: SavedTileViewNode | null;
  dropped: boolean;
} {
  let dropped = false;
  const convert = (node: TileNode): SavedTileViewNode | null => {
    if (node.kind === "group") {
      if (node.floating) {
        dropped = true;
        return null;
      }
      const areas = node.tabs.flatMap((tabId) => {
        const pending = layout.pendingAreas?.[tabId];
        if (pending) return [pending];
        if (isNewTab(tabId)) return [];
        const kind = tabArea(tabId);
        const area =
          kind === "side-chat" || kind === "pull-request" || kind === "device" ? null : kind;
        if (!area) dropped = true;
        return area ? [area] : [];
      });
      return areas.length ? { kind: "group", areas: areas.slice(0, 8) } : null;
    }
    const first = convert(node.first);
    const second = convert(node.second);
    return first && second
      ? { kind: "split", axis: node.axis, ratio: node.ratio, first, second }
      : (first ?? second);
  };
  const root = convert(layout.root);
  return { root, dropped };
}

/**
 * A saved layout's fields for a tree: `root` without views, which builds without views can decode,
 * and `viewRoot` with them when the tree has any. A tree of only views keeps the chat as its root.
 */
export function savedTileLayoutTrees(
  tree: SavedTileViewNode,
): Pick<SavedTileLayout, "root" | "viewRoot"> {
  let hasViews = false;
  const strip = (node: SavedTileViewNode): SavedTileNode | null => {
    if (node.kind === "group") {
      const areas = node.areas.filter((area): area is TileLayoutArea => !isViewArea(area));
      if (areas.length < node.areas.length) hasViews = true;
      return areas.length ? { kind: "group", areas } : null;
    }
    const first = strip(node.first);
    const second = strip(node.second);
    return first && second ? { ...node, first, second } : (first ?? second);
  };
  const root = strip(tree) ?? { kind: "group", areas: ["chat"] };
  return hasViews ? { root, viewRoot: tree } : { root };
}

/** The tree to lay out: the one with views when this layout has them. */
export function savedLayoutTree(layout: SavedTileLayout): SavedTileViewNode {
  return layout.viewRoot ?? layout.root;
}

export function savedTileGroupCount(node: SavedTileViewNode): number {
  return node.kind === "group"
    ? 1
    : savedTileGroupCount(node.first) + savedTileGroupCount(node.second);
}

/**
 * Lays out a thread from a saved layout. Open tabs fill matching areas in order; areas without one
 * get a placeholder that the workspace fills with a fresh surface. Leftover tabs join the chat tile.
 */
export function buildTileLayoutFromSaved(
  saved: SavedTileViewNode,
  openTabIds: readonly string[],
  makeId: () => string,
): ThreadTileLayout {
  const unused = [CONVERSATION_TAB_ID, ...openTabIds.filter((id) => id !== CONVERSATION_TAB_ID)];
  const pendingAreas: Record<string, TileArea> = {};
  const placedViews = new Set<string>();
  const build = (node: SavedTileViewNode): TileNode => {
    if (node.kind === "split")
      return {
        kind: "split",
        id: makeId(),
        axis: node.axis,
        ratio: node.ratio,
        first: build(node.first),
        second: build(node.second),
      };
    const tabs = node.areas.flatMap((savedArea) => {
      let area = savedArea;
      if (isViewArea(savedArea)) {
        const view = viewIdFromArea(savedArea);
        if (view === null || placedViews.has(view)) return [];
        placedViews.add(view);
        area = `view:${storedViewId(view)}`;
      }
      const index = unused.findIndex((tabId) => tabArea(tabId) === area);
      if (index >= 0) return unused.splice(index, 1);
      if (area === "chat") return [];
      const placeholder = newTabId(makeId());
      pendingAreas[placeholder] = area;
      return [placeholder];
    });
    return { kind: "group", id: makeId(), tabs, activeTabId: tabs[0] ?? "" };
  };
  let root = build(saved);
  const groups = getTileGroups(root);
  const home =
    groups.find((group) => group.tabs.includes(CONVERSATION_TAB_ID)) ??
    groups.find((group) => group.tabs.length) ??
    groups[0]!;
  if (unused.length) {
    const leftovers = unused;
    const replace = (node: TileNode): TileNode =>
      node.kind === "group"
        ? node.id === home.id
          ? {
              ...node,
              tabs: leftovers.includes(CONVERSATION_TAB_ID)
                ? [CONVERSATION_TAB_ID, ...node.tabs, ...leftovers.slice(1)]
                : [...node.tabs, ...leftovers],
              activeTabId: leftovers.includes(CONVERSATION_TAB_ID)
                ? CONVERSATION_TAB_ID
                : node.activeTabId || leftovers[0]!,
            }
          : node
        : { ...node, first: replace(node.first), second: replace(node.second) };
    root = replace(root);
  }
  const fill = (node: TileNode): TileNode =>
    node.kind === "split"
      ? { ...node, first: fill(node.first), second: fill(node.second) }
      : node.tabs.length
        ? node
        : { ...node, tabs: [newTabId(node.id)], activeTabId: newTabId(node.id) };
  return {
    root: fill(root),
    focusedGroupId: home.id,
    maximizedGroupId: null,
    ...(Object.keys(pendingAreas).length ? { pendingAreas } : {}),
  };
}

/** A project override wins, and null there means none; an id no longer saved falls back. */
export function resolveDefaultTileLayout(
  settings: Pick<
    ServerSettings,
    "tileLayouts" | "defaultTileLayoutId" | "projectSettingsOverrides"
  >,
  projectId: ProjectId | null,
): SavedTileLayout | null {
  const find = (id: string | null | undefined) =>
    settings.tileLayouts.find((layout) => layout.id === id);
  const override = projectId
    ? settings.projectSettingsOverrides[projectId]?.defaultTileLayoutId
    : undefined;
  if (override === null) return null;
  return find(override) ?? find(settings.defaultTileLayoutId) ?? null;
}

/** Removes a layout and every default that names it, global and per project, in one patch. */
export function tileLayoutDeletePatch(
  settings: Pick<
    ServerSettings,
    "tileLayouts" | "defaultTileLayoutId" | "projectSettingsOverrides"
  >,
  layoutId: string,
): ServerSettingsPatch {
  const projectIds = (Object.keys(settings.projectSettingsOverrides) as ProjectId[]).filter(
    (projectId) => settings.projectSettingsOverrides[projectId]?.defaultTileLayoutId === layoutId,
  );
  return {
    tileLayouts: settings.tileLayouts.filter((layout) => layout.id !== layoutId),
    ...(settings.defaultTileLayoutId === layoutId ? { defaultTileLayoutId: null } : {}),
    ...(projectIds.length
      ? {
          projectSettingsOverrides: Object.fromEntries(
            projectIds.map((projectId) => [
              projectId,
              clearProjectSettingsOverrides(settings, projectId, ["defaultTileLayoutId"]),
            ]),
          ),
        }
      : {}),
  };
}
