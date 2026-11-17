import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  INITIAL_TOOL_SIDEBAR,
  restoreToolSidebar,
  transitionToolSidebar,
  type ToolSidebarAction,
  type ToolSidebarState,
} from "./components/ToolSidebar.logic";

interface ToolSidebarStore extends ToolSidebarState {
  dispatch: (action: ToolSidebarAction) => void;
}

export const useToolSidebarStore = create<ToolSidebarStore>()(
  persist(
    (set) => ({
      ...INITIAL_TOOL_SIDEBAR,
      dispatch: (action) => set((state) => transitionToolSidebar(state, action)),
    }),
    {
      name: "weavewing_tool_sidebar",
      storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
      partialize: ({ visible, activeTool, width }) => ({ visible, activeTool, width }),
      merge: (persisted, current) => ({ ...current, ...restoreToolSidebar(persisted) }),
    },
  ),
);
