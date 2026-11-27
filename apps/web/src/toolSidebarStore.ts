import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  INITIAL_SIDE_AREA,
  SIDE_AREA_WIDE_MEDIA_QUERY,
  restoreSideArea,
  transitionSideArea,
  type SideAreaAction,
  type SideAreaState,
  type ViewId,
} from "./components/ToolSidebar.logic";

interface SideAreaStore extends SideAreaState {
  dispatch: (action: SideAreaAction) => void;
}

// What had focus when the side area opened; closing hands focus back to it.
let returnFocus: HTMLElement | null = null;
let focusOnOpen = false;

/** True once after an action opened the side area, so a reload that restores it open keeps focus. */
export function takeSideAreaFocusRequest(): boolean {
  const requested = focusOnOpen;
  focusOnOpen = false;
  return requested;
}

/** A resolved location, its path and position in the session history; unset before the first. */
export interface SideAreaRoute {
  readonly pathname: string | undefined;
  readonly index: number | undefined;
}

let handoff: {
  readonly view: ViewId;
  readonly from: string;
  readonly toIndex: number;
} | null = null;

/**
 * Opens `view` in the side area once the route leaves `from` for history entry `toIndex`, so a
 * page can hand its view over as it goes back. That route change does not close the side area,
 * and any other route change ignores the handoff.
 */
export function requestSideAreaHandoff(view: ViewId, from: string, toIndex: number) {
  handoff = { view, from, toIndex };
}

export function cancelSideAreaHandoff() {
  handoff = null;
}

function handoffArrived(route: SideAreaRoute) {
  return handoff !== null && handoff.toIndex === route.index && handoff.from !== route.pathname;
}

/** True when a handoff is arriving on `route`, which must not close the side area. */
export function isSideAreaHandoffArriving(route: SideAreaRoute): boolean {
  return handoffArrived(route);
}

/**
 * Opens the handed-over view on `route` and returns true, or false with no handoff for it.
 * Closing the side area afterwards returns focus to `returnTo`, a control on this route.
 */
export function completeSideAreaHandoff(route: SideAreaRoute, returnTo: HTMLElement | null) {
  if (!handoff || !handoffArrived(route)) return false;
  const { view } = handoff;
  handoff = null;
  useToolSidebarStore.getState().dispatch({ type: "show", view });
  returnFocus = returnTo;
  focusOnOpen = false;
  return true;
}

export const useToolSidebarStore = create<SideAreaStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_SIDE_AREA,
      dispatch: (action) => {
        const wasOpen = get().open;
        const next = transitionSideArea(get(), action);
        if (!wasOpen && next.open) {
          returnFocus =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          focusOnOpen = true;
        }
        // Focus the user moved elsewhere while it was open stays where they put it.
        const active = document.activeElement;
        const focusInside =
          active === null ||
          active === document.body ||
          active.closest("[data-side-area]") !== null;
        set(next);
        if (wasOpen && !next.open) {
          const target = returnFocus;
          returnFocus = null;
          focusOnOpen = false;
          if (focusInside && target?.isConnected) target.focus({ preventScroll: true });
        }
      },
    }),
    {
      name: "weavewing_tool_sidebar",
      storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
      partialize: ({ open, view, width, pinned, locked }) => ({
        open,
        view,
        width,
        pinned,
        locked,
      }),
      merge: (persisted, current) => ({ ...current, ...restoreSideArea(persisted) }),
    },
  ),
);

/**
 * Gives the drop-down terminal room when it opens or is used: a maximized side area returns to
 * its width beside the terminal, and a full-width sheet closes.
 */
export function makeRoomForDropdownTerminal() {
  const state = useToolSidebarStore.getState();
  if (!state.open) return;
  if (!window.matchMedia(SIDE_AREA_WIDE_MEDIA_QUERY).matches) state.dispatch({ type: "close" });
  else if (state.maximized) state.dispatch({ type: "restore" });
}
