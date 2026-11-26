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
