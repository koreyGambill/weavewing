import {
  isHostPath,
  isWindowsAbsolutePath,
  normalizeProjectPathForDispatch,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

import { isListableHostFolder, joinHostPath } from "./filePath";

/** The folder above `path`, or null at a filesystem root. */
export function parentHostFolder(path: string): string | null {
  const windows = isWindowsAbsolutePath(path);
  const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const index = windows
    ? Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
    : trimmed.lastIndexOf("/");
  if (index < 0) return null;
  const parent = trimmed.slice(0, index);
  if (parent === "") return "/";
  if (parent === "~") return "~/";
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return isListableHostFolder(parent) ? parent : null;
}

/** The root to store for a tab: null when `root` is the workspace root itself. */
export function filesTabRoot(root: string, workspaceRoot: string): string | null {
  return workspaceRelativeFilePath(root, workspaceRoot) === "." ? null : root;
}

/** Reads a typed root: host paths stay as typed, anything else is relative to the workspace. */
export function resolveTypedFilesRoot(input: string, workspaceRoot: string): string | null {
  const path = normalizeProjectPathForDispatch(input);
  if (path === "" || path === ".") return null;
  return filesTabRoot(isHostPath(path) ? path : joinHostPath(workspaceRoot, path), workspaceRoot);
}

/** A path opened from a re-rooted tree keeps its workspace spelling when it is inside the workspace. */
export function workspacePathOf(path: string, workspaceRoot: string): string {
  const relative = workspaceRelativeFilePath(path, workspaceRoot);
  return relative === null || relative === "." ? path : relative;
}

/**
 * The folder a new tab opened "from here" starts at: the selected tree entry, else the focused
 * one, else the tab's own root. A file stands for the folder that holds it.
 */
export function newFilesTabRoot(input: {
  readonly treeRoot: string;
  readonly selectedPaths: readonly string[];
  readonly focusedPath: string | null;
  readonly entryKinds: ReadonlyMap<string, "file" | "directory">;
}): string {
  const picked = (input.selectedPaths.at(-1) ?? input.focusedPath)?.replace(/\/$/, "");
  if (!picked) return input.treeRoot;
  const folder =
    input.entryKinds.get(picked) === "directory"
      ? picked
      : picked.slice(0, Math.max(0, picked.lastIndexOf("/")));
  return folder === "" ? input.treeRoot : joinHostPath(input.treeRoot, folder);
}
