import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  INITIAL_SIDE_AREA,
  SIDE_AREA_WIDE_MEDIA_QUERY,
  adoptRetiredRail,
  restoreSideArea,
  type RetiredRailSelection,
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
// Whether the left rail's stored selection has yet to move here. Version 1 is written from the
// load that hands it off, so only state stored at version 1 means it already moved; older, missing
// or unreadable state is still waiting for it.
let railHandoffPending = true;
let storedBeforeHandoff = false;
// Counts requests to open a view, so a click that opened one is not also a click outside it.
let openRequests = 0;

/** How many requests to open a view have been made; changes when an action opens or switches one. */
export function sideAreaOpenRequests(): number {
  return openRequests;
}

/** True once after an action opened the side area, so a reload that restores it open keeps focus. */
export function takeSideAreaFocusRequest(): boolean {
  const requested = focusOnOpen;
  focusOnOpen = false;
  return requested;
}

/** A resolved history entry: its path, key and position; unset before the first resolves. */
export interface SideAreaRoute {
  readonly pathname: string | undefined;
  readonly key: string | undefined;
  readonly index: number | undefined;
}

let handoff: {
  readonly from: SideAreaRoute;
  readonly toIndex: number;
} | null = null;

/**
 * Opens `view` in the side area now and keeps it open while the page that asked navigates from
 * history entry `from` to entry `toIndex`: that route change does not close the side area, and
 * focus stays in it. Any other route change ignores the handoff.
 */
export function requestSideAreaHandoff(view: ViewId, from: SideAreaRoute, toIndex: number) {
  handoff = { from, toIndex };
  useToolSidebarStore.getState().dispatch({ type: "show", view });
}

/** Drops a pending handoff unless `route` is the entry it goes to. */
export function cancelSideAreaHandoff(route?: SideAreaRoute) {
  if (route === undefined || !isSideAreaHandoffArriving(route)) handoff = null;
}

/** True when `route` is the entry a pending handoff goes to, which must not close the side area. */
export function isSideAreaHandoffArriving(route: SideAreaRoute): boolean {
  return (
    handoff !== null &&
    handoff.toIndex === route.index &&
    handoff.from.key !== route.key &&
    handoff.from.pathname !== route.pathname
  );
}

/**
 * Ends the handoff arriving on `route` and returns true, or false when none arrives there.
 * Closing the side area afterwards returns focus to `returnTo`, a control on this route.
 */
export function completeSideAreaHandoff(route: SideAreaRoute, returnTo: HTMLElement | null) {
  if (!isSideAreaHandoffArriving(route)) return false;
  handoff = null;
  returnFocus = returnTo;
  return true;
}

export const useToolSidebarStore = create<SideAreaStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_SIDE_AREA,
      dispatch: (action) => {
        const wasOpen = get().open;
        const next = transitionSideArea(get(), action);
        if (action.type === "show" || action.type === "toggleView" || next.open !== wasOpen) {
          openRequests += 1;
        }
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
      version: 1,
      storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
      partialize: ({ open, view, width, pinned, locked, threadView }) => ({
        open,
        view,
        width,
        pinned,
        locked,
        threadView,
      }),
      // Before version 1 no handoff had happened; the shape is read by `restoreSideArea`.
      migrate: (persisted) => {
        storedBeforeHandoff = true;
        return persisted as SideAreaStore;
      },
      merge: (persisted, current) => {
        railHandoffPending = persisted === undefined || storedBeforeHandoff;
        return { ...current, ...restoreSideArea(persisted) };
      },
    },
  ),
);

/**
 * Carries the retired left rail's stored selection into the side area, once: only while the side
 * area's own stored state predates it. The rail's store calls this when it migrates.
 */
export function adoptRetiredRailSelection(rail: RetiredRailSelection) {
  if (!railHandoffPending) return;
  railHandoffPending = false;
  useToolSidebarStore.setState((state) => adoptRetiredRail(state, rail));
}

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
