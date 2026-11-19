import type { OutsideWorkspaceEditGrant, ProjectReadFileResult } from "@t3tools/contracts";

/**
 * Whether a host file is editable now. A grant added or revoked elsewhere arrives in settings
 * before the read refreshes, so the live grant list decides when the read names its target.
 * Undefined grants mean settings have not arrived, and the read decides.
 */
export function hostEditState(
  file: Pick<ProjectReadFileResult, "writable" | "editGrant" | "grantTarget">,
  grants: ReadonlyArray<OutsideWorkspaceEditGrant> | undefined,
): { readonly writable: boolean; readonly editGrant: OutsideWorkspaceEditGrant | undefined } {
  const read = { writable: file.writable === true, editGrant: file.editGrant };
  if (grants === undefined) return read;
  // Writable without a grant: the instruction file allowlist.
  if (read.writable && read.editGrant === undefined) return read;
  const target = file.grantTarget;
  const editGrant =
    target === undefined
      ? grants.find(
          (grant) => grant.kind === read.editGrant?.kind && grant.path === read.editGrant.path,
        )
      : (grants.find((grant) => grant.kind === "file" && grant.path === target.path) ??
        grants.find((grant) => grant.kind === "workspace" && grant.path === target.workspaceRoot));
  return { writable: editGrant !== undefined, editGrant };
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
    ...(read?.canGrantEdit === undefined ? {} : { canGrantEdit: read.canGrantEdit }),
    ...(read?.grantTarget === undefined ? {} : { grantTarget: read.grantTarget }),
  };
}
