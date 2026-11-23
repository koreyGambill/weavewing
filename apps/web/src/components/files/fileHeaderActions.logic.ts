import type { SourceControlFileLink, SourceControlFileLinkTarget } from "@t3tools/contracts";

/** `null` hides the action; a reason keeps it visible but disabled. */
export type FileHeaderAction = { readonly disabledReason: string | null } | null;

const ENABLED: FileHeaderAction = { disabledReason: null };
const disabled = (reason: string): FileHeaderAction => ({ disabledReason: reason });

export type FileLinkState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly link: SourceControlFileLink };

/** An action that sends the file to a place outside T3 Code, such as its forge page. */
export interface FileRemoteAction {
  readonly id: string;
  readonly label: string;
  readonly kind: "open" | "copy";
  readonly url: string | null;
  /** The ref the link names and why, or the reason it is disabled. */
  readonly detail: string | null;
  readonly disabledReason: string | null;
  /** `header` shows as a button; `overflow` lives in the header's More actions menu. */
  readonly placement: "header" | "overflow";
}

type FileLinkAvailable = Extract<SourceControlFileLink, { _tag: "Available" }>;

/** A new external target is one entry here; every file surface renders this list. */
const FILE_REMOTE_TARGETS: ReadonlyArray<{
  readonly id: string;
  readonly kind: FileRemoteAction["kind"];
  readonly placement: FileRemoteAction["placement"];
  readonly label: (forge: string) => string;
  readonly target: (link: FileLinkAvailable) => SourceControlFileLinkTarget | null;
  readonly detail: (link: FileLinkAvailable) => string;
  readonly missing: (link: FileLinkAvailable) => string;
}> = [
  {
    id: "open-on-forge",
    kind: "open",
    placement: "header",
    label: (forge) => `Open on ${forge}`,
    target: (link) => link.link,
    detail: chosenRefDetail,
    missing: () => "",
  },
  {
    id: "copy-forge-link",
    kind: "copy",
    placement: "overflow",
    label: (forge) => `Copy ${forge} link`,
    target: (link) => link.link,
    detail: (link) => link.link.ref,
    missing: () => "",
  },
  {
    id: "open-default-branch",
    kind: "open",
    placement: "overflow",
    label: () => "Open on default branch",
    target: (link) => link.defaultBranch,
    detail: (link) => link.defaultBranch?.ref ?? "",
    missing: (link) => `${link.remoteName} has no default branch fetched`,
  },
  {
    id: "open-current-branch",
    kind: "open",
    placement: "overflow",
    label: () => "Open on current branch",
    target: (link) => link.currentBranch,
    detail: (link) => link.currentBranch?.ref ?? "",
    missing: (link) => `This branch has no upstream on ${link.remoteName}`,
  },
];

function chosenRefDetail(link: FileLinkAvailable): string {
  switch (link.choice) {
    case "default":
      return `${link.link.ref}, the default branch`;
    case "current":
      return `${link.link.ref}, the current branch, since the default branch does not have this file`;
    case "default-without-upstream":
      return `${link.link.ref}, the default branch, since this branch has no upstream on ${link.remoteName}`;
  }
}

function unavailableReason(state: FileLinkState): string {
  if (state.status === "loading") return "Reading the file's repository";
  if (state.status === "failed") return "Could not read the file's repository";
  const link = state.link;
  if (link._tag === "Available") return "";
  switch (link.reason) {
    case "not-repository":
      return "This file is not in a git repository with a remote";
    case "unsupported-host":
      return `T3 Code cannot link files on ${link.host ?? "this remote's host"}`;
    case "no-branch":
      return "The remote has no default branch fetched, and this branch has no upstream there";
  }
}

export function resolveFileRemoteActions(state: FileLinkState): ReadonlyArray<FileRemoteAction> {
  const link = state.status === "ready" && state.link._tag === "Available" ? state.link : null;
  const forge = link?.providerLabel ?? "remote";
  const reason = link === null ? unavailableReason(state) : null;
  return FILE_REMOTE_TARGETS.map((entry) => {
    const target = link === null ? null : entry.target(link);
    const disabledReason = reason ?? (target === null && link ? entry.missing(link) : null);
    return {
      id: entry.id,
      label: entry.label(forge),
      kind: entry.kind,
      placement: entry.placement,
      url: target?.url ?? null,
      detail: link !== null && target !== null ? entry.detail(link) : null,
      disabledReason,
    };
  });
}

/**
 * Every host file gets the same core actions so its header does not change with where the
 * file lives or how it can be edited. File-type actions follow in their own group.
 */
export function resolveFileHeaderActions(input: {
  readonly absolutePath: string | null;
  readonly isFolder: boolean;
  /** Outside the workspace, so the workspace explorer cannot show it. */
  readonly isHostFile: boolean;
  /** Bound to one file, as Notes is, so nothing may navigate it to another. */
  readonly pinned?: boolean;
  /** From `shouldShowOpenInPicker` for the file's environment. */
  readonly openInSupported: boolean;
  /** Text the find bar can search, whether or not it loaded whole. */
  readonly searchableText: boolean;
  readonly truncated: boolean;
  /** Null for a folder, which has no single page on the forge to link. */
  readonly fileLink: FileLinkState | null;
}): {
  readonly openIn: FileHeaderAction;
  readonly copyPath: FileHeaderAction;
  readonly explorer: FileHeaderAction;
  readonly find: FileHeaderAction;
  readonly remote: ReadonlyArray<FileRemoteAction>;
} {
  if (input.absolutePath === null) {
    return { openIn: null, copyPath: null, explorer: null, find: null, remote: [] };
  }
  return {
    openIn: input.openInSupported
      ? ENABLED
      : disabled("Editors cannot open files from this environment"),
    copyPath: ENABLED,
    // A folder view is the explorer, so a toggle would only hide the tree it is showing.
    explorer:
      input.isFolder || input.pinned === true
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
    remote:
      input.isFolder || input.fileLink === null ? [] : resolveFileRemoteActions(input.fileLink),
  };
}
