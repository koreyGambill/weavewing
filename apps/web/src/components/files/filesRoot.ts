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
 * The folder path to ask the environment to resolve for a typed root. Home, absolute and (on
 * Windows) rooted or drive-relative paths go as typed; anything else is made explicitly relative
 * so the server resolves it in the workspace. The trailing separator asks for the folder itself.
 */
export function filesRootBrowsePath(input: string, windows: boolean): string | null {
  const path = input.trim();
  if (path === "") return null;
  const anchored =
    /^~(?:$|[\\/])/.test(path) ||
    isHostPath(path) ||
    isExplicitRelativePath(path) ||
    (windows && /^(?:[\\/]|[A-Za-z]:)/.test(path));
  const target = anchored ? path : `./${path}`;
  return target === "~" || /[\\/]$/.test(target) ? target : `${target}/`;
}

/** The environment's answer for a folder: its resolved path and, when known, its real path. */
export interface ResolvedFolder {
  readonly path: string;
  readonly realPath?: string | undefined;
}

/**
 * Resolves a root on the environment, which expands `~` and `..` against its own home and
 * filesystem, and returns the root to store: null at the workspace root, the workspace spelling
 * for a folder whose real path is inside the workspace, and the real folder otherwise.
 */
export async function resolveFilesRoot(
  input: string,
  options: {
    readonly workspaceRoot: string;
    readonly windows: boolean;
    readonly resolveFolder: (partialPath: string, cwd: string) => Promise<ResolvedFolder>;
  },
): Promise<string | null | undefined> {
  const { workspaceRoot, windows, resolveFolder } = options;
  const partialPath = filesRootBrowsePath(input, windows);
  if (partialPath === null) return undefined;
  const [folder, workspace] = await Promise.all([
    resolveFolder(partialPath, workspaceRoot),
    resolveFolder(filesRootBrowsePath(workspaceRoot, windows)!, workspaceRoot),
  ]);
  const realFolder = normalizeProjectPathForDispatch(folder.realPath ?? folder.path);
  const realWorkspace = normalizeProjectPathForDispatch(workspace.realPath ?? workspace.path);
  const relative = workspaceRelativeFilePath(realFolder, realWorkspace);
  if (relative === ".") return null;
  return relative === null ? realFolder : joinHostPath(workspaceRoot, relative);
}

/** Each call starts a request and returns whether that request is still the latest one. */
export function latestRequest(): () => () => boolean {
  let latest = 0;
  return () => {
    const request = ++latest;
    return () => request === latest;
  };
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
