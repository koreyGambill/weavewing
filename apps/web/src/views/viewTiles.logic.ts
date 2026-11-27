import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  isGlobalViewId,
  migrateViewId,
  storedViewId,
  type ViewId,
} from "../components/ToolSidebar.logic";
import type { RightPanelSurface } from "../rightPanelStore";

export type ViewSurface = Extract<RightPanelSurface, { kind: "view" }>;

/**
 * A view tab in a thread's tiles. Its id names another thread only when it shows one, so a view of
 * the tile's own thread, or a global view, has the same id in every thread and can be saved.
 */
export function viewSurface(
  viewId: ViewId,
  owner: ScopedThreadRef,
  thread: ScopedThreadRef | null,
): ViewSurface {
  const id: ViewSurface["id"] = `view:${storedViewId(viewId)}`;
  const other =
    !isGlobalViewId(viewId) && thread !== null && scopedThreadKey(thread) !== scopedThreadKey(owner)
      ? thread
      : null;
  return other
    ? { id: `${id}:${scopedThreadKey(other)}`, kind: "view", viewId, threadRef: other }
    : { id, kind: "view", viewId };
}

/** The thread a view tab shows: the one it was locked to, else its tile's; none for global views. */
export function viewTileThread(
  surface: ViewSurface,
  owner: ScopedThreadRef,
): ScopedThreadRef | null {
  if (isGlobalViewId(surface.viewId)) return null;
  return surface.threadRef ?? owner;
}

const StoredViewSurface = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("view"),
  viewId: Schema.String,
  threadRef: Schema.optionalKey(ScopedThreadRef),
});
const decodeStoredViewSurface = Schema.decodeUnknownOption(StoredViewSurface);

/** The view a stored or saved view id opens, or null when it names none. */
function normalizeStoredViewId(id: string): ViewId | null {
  return migrateViewId(id);
}

/** A stored view tab, or null when its view no longer exists or its shape is wrong. */
export function restoreViewSurface(value: unknown): ViewSurface | null {
  const decoded = decodeStoredViewSurface(value);
  if (decoded._tag === "None") return null;
  const { id, viewId: stored, threadRef } = decoded.value;
  const viewId = normalizeStoredViewId(stored);
  if (viewId === null || (threadRef && isGlobalViewId(viewId))) return null;
  const target = threadRef ? `:${scopedThreadKey(threadRef)}` : "";
  const tabId: ViewSurface["id"] = `view:${storedViewId(viewId)}${target}`;
  if (id !== `view:${stored}${target}` && id !== tabId) return null;
  return threadRef
    ? { id: tabId, kind: "view", viewId, threadRef }
    : { id: tabId, kind: "view", viewId };
}

/** The stored form uses IDs a build before the view merge can reopen. */
export function persistViewSurface(surface: ViewSurface) {
  return { ...surface, viewId: storedViewId(surface.viewId) };
}

export function isViewArea(area: string): area is `view:${string}` {
  return area.startsWith("view:");
}

/** The view a saved-layout area opens, or null for other areas and views that no longer exist. */
export function viewIdFromArea(area: string): ViewId | null {
  if (!isViewArea(area)) return null;
  return normalizeStoredViewId(area.slice("view:".length));
}

/** Uses the same persisted id for a view tab, its placeholder and its saved area. */
export function normalizeStoredViewTabId(tabId: string): string {
  if (!isViewArea(tabId)) return tabId;
  const [id = "", ...target] = tabId.slice("view:".length).split(":");
  const view = normalizeStoredViewId(id);
  return view === null ? tabId : ["view", storedViewId(view), ...target].join(":");
}

/** "Activity" for the tile's own thread, "Activity · Other thread" for a view locked elsewhere. */
export function viewTabTitle(viewTitle: string, lockedThreadTitle: string | null): string {
  return lockedThreadTitle === null ? viewTitle : `${viewTitle} · ${lockedThreadTitle}`;
}
