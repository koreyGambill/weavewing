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
