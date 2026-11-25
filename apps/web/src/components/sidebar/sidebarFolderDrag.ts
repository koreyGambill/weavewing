import type { DragEvent } from "react";

/** Marks a native drag as project folders, so thread rows and the composer ignore it. */
export const PROJECT_FOLDER_DRAG_TYPE = "application/x-t3-project-folders";

export function isProjectFolderDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(PROJECT_FOLDER_DRAG_TYPE);
}
