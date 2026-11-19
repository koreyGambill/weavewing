import {
  isExplicitRelativePath,
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

/**
 * The folder path to ask the environment to resolve for a typed root. Home and absolute paths go
 * as typed; anything else is made explicitly relative so the server resolves it in the workspace.
 * The trailing separator asks the server for the folder itself rather than its parent.
 */
export function filesRootBrowsePath(input: string): string | null {
  const path = input.trim();
  if (path === "") return null;
  const target =
    /^~(?:$|[\\/])/.test(path) || isHostPath(path) || isExplicitRelativePath(path)
      ? path
      : `./${path}`;
  return target === "~" || /[\\/]$/.test(target) ? target : `${target}/`;
}

/**
 * Resolves a typed root on the environment, which expands `~` and `..` against its own home and
 * filesystem, and returns the root to store: the canonical folder, or null at the workspace root.
 */
export async function resolveFilesRoot(
  input: string,
  workspaceRoot: string,
  resolveFolder: (partialPath: string, cwd: string) => Promise<string>,
): Promise<string | null | undefined> {
  const partialPath = filesRootBrowsePath(input);
  if (partialPath === null) return undefined;
  const folder = normalizeProjectPathForDispatch(await resolveFolder(partialPath, workspaceRoot));
  return filesTabRoot(folder, workspaceRoot);
}

/** Server search runs inside the workspace only; other roots search the folders already listed. */
export function filesSearchRoot(treeRoot: string, workspaceRoot: string): string | null {
  return workspaceRelativeFilePath(treeRoot, workspaceRoot) === null ? null : treeRoot;
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
