import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isGlobalViewId, isViewId, type ViewId } from "../components/ToolSidebar.logic";
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
  const other =
    !isGlobalViewId(viewId) && thread !== null && scopedThreadKey(thread) !== scopedThreadKey(owner)
      ? thread
      : null;
  return other
    ? { id: `view:${viewId}:${scopedThreadKey(other)}`, kind: "view", viewId, threadRef: other }
    : { id: `view:${viewId}`, kind: "view", viewId };
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

/** A stored view tab, or null when its view no longer exists or its shape is wrong. */
export function restoreViewSurface(value: unknown): ViewSurface | null {
  const decoded = decodeStoredViewSurface(value);
  if (decoded._tag === "None") return null;
  const { id, viewId, threadRef } = decoded.value;
  if (!isViewId(viewId)) return null;
  const expected = threadRef ? `view:${viewId}:${scopedThreadKey(threadRef)}` : `view:${viewId}`;
  if (id !== expected || (threadRef && isGlobalViewId(viewId))) return null;
  return threadRef
    ? { id: expected as ViewSurface["id"], kind: "view", viewId, threadRef }
    : { id: expected as ViewSurface["id"], kind: "view", viewId };
}

export function isViewArea(area: string): area is `view:${string}` {
  return area.startsWith("view:");
}

/** The view a saved-layout area opens, or null for other areas and views that no longer exist. */
export function viewIdFromArea(area: string): ViewId | null {
  if (!isViewArea(area)) return null;
  const id = area.slice("view:".length);
  return isViewId(id) ? id : null;
}

/** True for a `view:` area whose view no longer exists; restoring drops its tab. */
export function isRetiredViewArea(area: string): boolean {
  return isViewArea(area) && viewIdFromArea(area) === null;
}

/** "Activity" for the tile's own thread, "Activity · Other thread" for a view locked elsewhere. */
export function viewTabTitle(viewTitle: string, lockedThreadTitle: string | null): string {
  return lockedThreadTitle === null ? viewTitle : `${viewTitle} · ${lockedThreadTitle}`;
}
