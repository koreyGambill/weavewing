import type { OutsideWorkspaceEditGrant, ProjectReadFileResult } from "@t3tools/contracts";

/**
 * Whether a host file is editable now: the read says so, and the grant behind it, if any, is
 * still in the environment's grant list. Undefined grants mean settings have not arrived.
 */
export function hostEditState(
  file: Pick<ProjectReadFileResult, "writable" | "editGrant">,
  grants: ReadonlyArray<OutsideWorkspaceEditGrant> | undefined,
): { readonly writable: boolean; readonly editGrant: OutsideWorkspaceEditGrant | undefined } {
  const granted = file.editGrant;
  const active =
    granted === undefined ||
    grants === undefined ||
    grants.some((grant) => grant.kind === granted.kind && grant.path === granted.path);
  return {
    writable: file.writable === true && active,
    editGrant: active ? granted : undefined,
  };
}

/** Unsaved edits keep the read's edit access, so the editor and badge stay as they were. */
export function editedHostFileData(
  relativePath: string,
  contents: string,
  read: ProjectReadFileResult | undefined,
): ProjectReadFileResult {
  return {
    relativePath,
    contents,
    byteLength: new TextEncoder().encode(contents).byteLength,
    truncated: false,
    ...(read?.writable === true ? { writable: true } : {}),
    ...(read?.editGrant === undefined ? {} : { editGrant: read.editGrant }),
  };
}
