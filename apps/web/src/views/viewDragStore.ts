import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { ViewId } from "../components/ToolSidebar.logic";

/** The drag data type the side panel's grip sets, beside the tile drag types. */
export const VIEW_DRAG_TYPE = "application/x-weavewing-view";

/** The side panel view being dragged toward the tiles, and the thread it shows. */
export interface ViewDrag {
  readonly viewId: ViewId;
  readonly thread: ScopedThreadRef | null;
}

/** Drag data is unreadable during dragover, so the workspace reads the dragged view from here. */
export const useViewDragStore = create<{ drag: ViewDrag | null }>(() => ({ drag: null }));
