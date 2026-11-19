import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

export interface DropdownTerminalTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly external: boolean;
}

interface DropdownTerminalState {
  open: boolean;
  expanded: boolean;
  selectedTarget: DropdownTerminalTarget | null;
  selectTarget: (target: DropdownTerminalTarget) => void;
  toggle: () => void;
  close: () => void;
  toggleExpanded: () => void;
}

// What had focus before the drop-down opened; hiding hands focus back to it.
let returnFocus: HTMLElement | null = null;

export const useDropdownTerminalStore = create<DropdownTerminalState>()((set, get) => ({
  open: false,
  expanded: false,
  selectedTarget: null,
  selectTarget: (selectedTarget) => set({ selectedTarget }),
  toggle: () => {
    if (get().open) {
      get().close();
      return;
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    set({ open: true });
  },
  close: () => {
    if (!get().open) return;
    // Focus the user moved elsewhere while it was open stays where they put it.
    const active = document.activeElement;
    const focusInPanel =
      active === null ||
      active === document.body ||
      active.closest("[data-dropdown-terminal]") !== null;
    set({ open: false });
    const target = returnFocus;
    returnFocus = null;
    if (focusInPanel && target?.isConnected) target.focus({ preventScroll: true });
  },
  toggleExpanded: () => set((state) => ({ expanded: !state.expanded })),
}));
