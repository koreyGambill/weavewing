import { DROPDOWN_TERMINAL_THREAD_ID, type EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { newDropdownTerminalTabId, restoreDropdownTerminalTabs } from "./dropdownTerminal.logic";
import { resolveStorage } from "./lib/storage";

export interface DropdownTerminalTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly external: boolean;
}

/**
 * A drop-down tab keeps its own tiles and shells on one machine. Its `id` is the thread id its
 * terminals are keyed under, so the server keeps each tab's shells and history apart.
 */
export interface DropdownTerminalTab {
  readonly id: string;
  readonly name: string | null;
  /**
   * The machine as last seen, so a tab still names it while disconnected or after a restart.
   * Null until the first tab is shown on the default machine.
   */
  readonly target: DropdownTerminalTarget | null;
}

// The first tab keeps the id the drop-down used before tabs, so its shells and layout carry over.
const FIRST_TAB: DropdownTerminalTab = {
  id: DROPDOWN_TERMINAL_THREAD_ID,
  name: null,
  target: null,
};

interface DropdownTerminalState {
  open: boolean;
  expanded: boolean;
  tabs: readonly DropdownTerminalTab[];
  activeTabId: string;
  /** Opens a tab on `target` after the active one and shows it. */
  addTab: (target: DropdownTerminalTarget | null, tabId?: string) => string;
  selectTab: (tabId: string) => void;
  renameTab: (tabId: string, name: string) => void;
  setTabTarget: (tabId: string, target: DropdownTerminalTarget) => void;
  /** Forgets a tab whose terminals are gone; the only tab stays and hides the drop-down. */
  removeTab: (tabId: string) => void;
  toggle: () => void;
  close: () => void;
  toggleExpanded: () => void;
}

// What had focus before the drop-down opened; hiding hands focus back to it.
let returnFocus: HTMLElement | null = null;

export function activeDropdownTerminalTab(
  state: Pick<DropdownTerminalState, "tabs" | "activeTabId">,
): DropdownTerminalTab {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? FIRST_TAB;
}

export const useDropdownTerminalStore = create<DropdownTerminalState>()(
  persist(
    (set, get) => ({
      open: false,
      expanded: false,
      tabs: [FIRST_TAB],
      activeTabId: FIRST_TAB.id,
      addTab: (target, tabId = newDropdownTerminalTabId()) => {
        const tab: DropdownTerminalTab = { id: tabId, name: null, target };
        set((state) => {
          const index = state.tabs.findIndex((entry) => entry.id === state.activeTabId);
          const tabs = [...state.tabs];
          tabs.splice(index < 0 ? tabs.length : index + 1, 0, tab);
          return { tabs, activeTabId: tab.id };
        });
        return tab.id;
      },
      selectTab: (activeTabId) => {
        if (get().tabs.some((tab) => tab.id === activeTabId)) set({ activeTabId });
      },
      renameTab: (tabId, name) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, name: name.trim() === "" ? null : name.trim() } : tab,
          ),
        })),
      setTabTarget: (tabId, target) =>
        set((state) => ({
          tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, target } : tab)),
        })),
      removeTab: (tabId) => {
        const { tabs, activeTabId } = get();
        const index = tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) return;
        if (tabs.length === 1) {
          get().close();
          return;
        }
        const remaining = tabs.filter((tab) => tab.id !== tabId);
        set({
          tabs: remaining,
          activeTabId:
            activeTabId === tabId
              ? (remaining[Math.min(index, remaining.length - 1)] ?? remaining[0]!).id
              : activeTabId,
        });
      },
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
    }),
    {
      name: "t3code:dropdown-terminal-tabs",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ tabs: state.tabs, activeTabId: state.activeTabId }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as { tabs?: unknown; activeTabId?: unknown };
        const tabs = restoreDropdownTerminalTabs(saved.tabs) ?? current.tabs;
        return {
          ...current,
          tabs,
          activeTabId: tabs.find((tab) => tab.id === saved.activeTabId)?.id ?? tabs[0]!.id,
        };
      },
    },
  ),
);
