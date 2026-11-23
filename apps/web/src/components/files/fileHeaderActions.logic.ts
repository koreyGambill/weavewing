/** `null` hides the action; a reason keeps it visible but disabled. */
export type FileHeaderAction = { readonly disabledReason: string | null } | null;

const ENABLED: FileHeaderAction = { disabledReason: null };
const disabled = (reason: string): FileHeaderAction => ({ disabledReason: reason });

/**
 * Every host file gets the same core actions so its header does not change with where the
 * file lives or how it can be edited. File-type actions follow in their own group.
 */
export function resolveFileHeaderActions(input: {
  readonly absolutePath: string | null;
  readonly isFolder: boolean;
  /** Outside the workspace, so the workspace explorer cannot show it. */
  readonly isHostFile: boolean;
  /** From `shouldShowOpenInPicker` for the file's environment. */
  readonly openInSupported: boolean;
  /** Text the find bar can search, whether or not it loaded whole. */
  readonly searchableText: boolean;
  readonly truncated: boolean;
}): {
  readonly openIn: FileHeaderAction;
  readonly copyPath: FileHeaderAction;
  readonly explorer: FileHeaderAction;
  readonly find: FileHeaderAction;
} {
  if (input.absolutePath === null) {
    return { openIn: null, copyPath: null, explorer: null, find: null };
  }
  return {
    openIn: input.openInSupported
      ? ENABLED
      : disabled("Editors cannot open files from this environment"),
    copyPath: ENABLED,
    // A folder view is the explorer, so a toggle would only hide the tree it is showing.
    explorer: input.isFolder
      ? null
      : input.isHostFile
        ? disabled("The file explorer shows this project's files, and this file is outside it")
        : ENABLED,
    find:
      input.isFolder || !input.searchableText
        ? null
        : input.truncated
          ? disabled("Find needs the whole file, but only the first 1 MB loaded")
          : ENABLED,
  };
}
