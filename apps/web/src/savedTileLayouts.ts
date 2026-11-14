import type {
  ProjectId,
  SavedTileLayout,
  SavedTileNode,
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
  type TileNode,
} from "./threadTileLayout";

export const TILE_LAYOUT_AREA_LABELS = {
  chat: "Main chat",
  browser: "Browser",
  terminal: "Terminal",
  files: "Files",
  notes: "Notes",
  diff: "Diff",
  "pull-requests": "Pull requests",
} as const satisfies Record<TileLayoutArea, string>;

const tabArea = (tabId: string): TileLayoutArea | null =>
  tabId === CONVERSATION_TAB_ID ? "chat" : surfaceTileArea(tabId);

/** The docked tree as a saved layout; `dropped` reports tabs or tiles a layout cannot keep. */
export function toSavedTileNode(layout: ThreadTileLayout): {
  root: SavedTileNode | null;
  dropped: boolean;
} {
  let dropped = false;
  const convert = (node: TileNode): SavedTileNode | null => {
    if (node.kind === "group") {
      if (node.floating) {
        dropped = true;
        return null;
      }
      const areas = node.tabs.flatMap((tabId) => {
        const pending = layout.pendingAreas?.[tabId];
        if (pending) return [pending];
        if (isNewTab(tabId)) return [];
        const area = tabArea(tabId);
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

export function savedTileGroupCount(node: SavedTileNode): number {
  return node.kind === "group"
    ? 1
    : savedTileGroupCount(node.first) + savedTileGroupCount(node.second);
}

/**
 * Lays out a thread from a saved layout. Open tabs fill matching areas in order; areas without one
 * get a placeholder that the workspace fills with a fresh surface. Leftover tabs join the chat tile.
 */
export function buildTileLayoutFromSaved(
  saved: SavedTileNode,
  openTabIds: readonly string[],
  makeId: () => string,
): ThreadTileLayout {
  const unused = [CONVERSATION_TAB_ID, ...openTabIds.filter((id) => id !== CONVERSATION_TAB_ID)];
  const pendingAreas: Record<string, TileLayoutArea> = {};
  const build = (node: SavedTileNode): TileNode => {
    if (node.kind === "split")
      return {
        kind: "split",
        id: makeId(),
        axis: node.axis,
        ratio: node.ratio,
        first: build(node.first),
        second: build(node.second),
      };
    const tabs = node.areas.flatMap((area) => {
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
