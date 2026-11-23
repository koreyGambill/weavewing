import { AssetWorkspaceAssetNotFoundError, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";

import type { MarkdownFileLinkMeta } from "../../markdown-links";
import type { RemoteOpenMode } from "../../remoteOpen";

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

export function markdownFileCopyMenuItems({
  targetPath,
  workspaceRelativePath,
}: Pick<MarkdownFileLinkMeta, "targetPath" | "workspaceRelativePath">) {
  const items = [
    { id: "copy-full", label: "Copy full path", value: targetPath, title: "Full path" },
  ];
  if (workspaceRelativePath !== null) {
    const position = targetPath.slice(splitFilePathPosition(targetPath).path.length);
    items.unshift({
      id: "copy-relative",
      label: "Copy relative path",
      value: `${workspaceRelativePath}${position}`,
      title: "Relative path",
    });
  }
  return items;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
}): boolean {
  return input.canOpenInBrowser && !input.canOpenInEditor && !input.canOpenInPanel;
}

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

/**
 * Where a file link's media opens when the file is gone: the file view's missing state, which
 * offers Find, rather than a toast. Null for any other failure, or media with no linked path.
 */
export function missingLinkedMediaPath(error: unknown, linkedPath: string | undefined) {
  return linkedPath !== undefined &&
    isAssetNotFoundError(error) &&
    error.resource._tag === "media-file"
    ? linkedPath
    : null;
}
