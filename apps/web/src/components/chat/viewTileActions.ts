import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import { focusSideArea, useToolSidebarStore } from "../../toolSidebarStore";
import { useViewDragStore } from "../../views/viewDragStore";
import { viewSurface, viewTileThread, type ViewSurface } from "../../views/viewTiles.logic";
import type { ViewId } from "../ToolSidebar.logic";

const focusTileContent = (surfaceId: string) =>
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`[data-tile-content="${CSS.escape(surfaceId)}"]`)
      ?.focus({ preventScroll: true }),
  );

/** After a view moves into a tile, an unpinned side panel closes and focus follows the view. */
function finishPromotion(surfaceId: string) {
  const side = useToolSidebarStore.getState();
  if (!side.pinned) side.dispatch({ type: "close" });
  focusTileContent(surfaceId);
}

/** Opens the side panel's view as a tab beside the chat of `owner`'s tiles. */
export function promoteViewToTile(
  owner: ScopedThreadRef,
  viewId: ViewId,
  thread: ScopedThreadRef | null,
) {
  useRightPanelStore.getState().openView(owner, viewId, thread, "tile-2");
  finishPromotion(viewSurface(viewId, owner, thread).id);
}

/**
 * Places a view dropped from the side panel: it opens as a tab, then the tile drop's own action
 * moves it where it landed.
 */
export function placeDroppedView(
  owner: ScopedThreadRef,
  drag: { readonly viewId: ViewId; readonly thread: ScopedThreadRef | null },
  place: (surfaceId: string) => void,
) {
  const surfaceId = viewSurface(drag.viewId, owner, drag.thread).id;
  useRightPanelStore.getState().openView(owner, drag.viewId, drag.thread);
  place(surfaceId);
  useViewDragStore.setState({ drag: null });
  finishPromotion(surfaceId);
}

/** Returns a view tab to the side panel, locked to its thread when that is not the tile's own. */
export function moveViewToSidePanel(owner: ScopedThreadRef, surface: ViewSurface) {
  const side = useToolSidebarStore.getState();
  if (viewTileThread(surface, owner) !== null) {
    side.dispatch({ type: "lock", thread: surface.threadRef ?? null });
  }
  side.dispatch({ type: "show", view: surface.viewId });
  useRightPanelStore.getState().closeSurface(owner, surface.id);
  focusSideArea();
}
