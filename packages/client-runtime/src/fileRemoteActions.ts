import type {
  RepositoryIdentity,
  SourceControlFileLink,
  SourceControlFileLinkTarget,
} from "@t3tools/contracts";

import { sourceControlClients } from "./sourceControlClients.ts";
import { PRODUCT_NAME } from "./productName.ts";

/** How long a menu waits for the server to read git before giving up on the forge rows. */
const FILE_LINK_TIMEOUT_MS = 3000;

export type FileLinkState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "timed-out" }
  | { readonly status: "ready"; readonly link: SourceControlFileLink };

/** An action that sends the file to a place outside the app, such as its forge page. */
export interface FileRemoteAction {
  readonly id: string;
  readonly label: string;
  readonly kind: "open" | "copy";
  readonly url: string | null;
  /** The ref the link names and why, or the reason it is disabled. */
  readonly detail: string | null;
  readonly disabledReason: string | null;
  /** `header` shows as a button; `overflow` lives in a More actions menu. */
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
    missing: noUpstreamReason,
  },
];

function noUpstreamReason(link: FileLinkAvailable): string {
  return link.branch === null
    ? "HEAD is detached, so there is no current branch"
    : `${link.branch} has no upstream on ${link.remoteName}`;
}

function chosenRefDetail(link: FileLinkAvailable): string {
  switch (link.choice) {
    case "default":
      return `${link.link.ref}, the default branch`;
    case "current":
      return `${link.link.ref}, the current branch, since the default branch does not have this file`;
    case "default-without-upstream":
      return `${link.link.ref}, the default branch, since ${
        link.branch === null
          ? "HEAD is detached"
          : `${link.branch} has no upstream on ${link.remoteName}`
      }`;
  }
}

function unavailableReason(state: FileLinkState): string {
  switch (state.status) {
    case "loading":
      return "Reading the file's repository";
    case "failed":
      return "Could not read the file's repository";
    case "timed-out":
      return "Couldn't read git in time";
    case "ready":
      break;
  }
  const link = state.link;
  if (link._tag === "Available") return "";
  switch (link.reason) {
    case "not-repository":
      return "This file is not in a git repository with a remote";
    case "unsupported-host":
      return `${PRODUCT_NAME} cannot link files on ${link.host ?? "this remote's host"}`;
    case "no-branch":
      return "The remote has no default branch fetched, and this branch has no upstream there";
    case "network-path":
      return `${PRODUCT_NAME} does not read git on network paths`;
    case "outside-workspace":
      return "This path leaves its workspace";
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

/** The open and copy pair for one cited range, labeled with that range, such as `72-80`. */
export function resolveFileRangeActions(
  state: FileLinkState,
  range: string,
): ReadonlyArray<FileRemoteAction> {
  const [open, copy] = resolveFileRemoteActions(state);
  const forge =
    state.status === "ready" && state.link._tag === "Available"
      ? state.link.providerLabel
      : "remote";
  return [
    { ...open!, id: `open-lines:${range}`, label: `Open lines ${range} on ${forge}` },
    { ...copy!, id: `copy-lines:${range}`, label: `Copy ${forge} link to lines ${range}` },
  ];
}

/** Settles a lookup, or reports it timed out once the menu's wait is over. */
export function settleFileLink(
  lookup: Promise<SourceControlFileLink>,
  timeoutMs: number = FILE_LINK_TIMEOUT_MS,
): Promise<FileLinkState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FileLinkState>((resolve) => {
    // @effect-diagnostics-next-line globalTimers:off - Menus await this outside an Effect runtime.
    timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
  });
  return Promise.race([
    lookup.then(
      (link): FileLinkState => ({ status: "ready", link }),
      (): FileLinkState => ({ status: "failed" }),
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/**
 * What a command can say before asking the server: the forge's name from the project's
 * repository, or why no link can exist.
 */
export function fileLinkPreflight(input: {
  readonly canReadFiles: boolean;
  readonly identity: RepositoryIdentity | null | undefined;
}): { readonly forge: string; readonly disabledReason: string | null } {
  const definition =
    input.identity?.provider === undefined
      ? undefined
      : sourceControlClients.find(input.identity.provider);
  const forge = definition?.label ?? "remote";
  if (!input.canReadFiles) return { forge, disabledReason: "This connection cannot read files" };
  // Unknown until the server reads git, so the press decides.
  if (input.identity === undefined) return { forge, disabledReason: null };
  if (input.identity === null)
    return { forge, disabledReason: "This project is not a git repository with a remote" };
  if (definition?.fileUrl === undefined)
    return {
      forge,
      disabledReason: `${PRODUCT_NAME} cannot link files on ${input.identity.canonicalKey.split("/")[0]}`,
    };
  return { forge, disabledReason: null };
}

/** The forge rows a menu shows before any lookup, disabled only for a reason known up front. */
export function pressTimeFileActions(
  preflight: { readonly forge: string; readonly disabledReason: string | null },
  ids?: ReadonlyArray<string>,
): ReadonlyArray<Pick<FileRemoteAction, "id" | "label" | "kind" | "disabledReason">> {
  return FILE_REMOTE_TARGETS.filter((entry) => ids === undefined || ids.includes(entry.id)).map(
    (entry) => ({
      id: entry.id,
      label: entry.label(preflight.forge),
      kind: entry.kind,
      disabledReason: preflight.disabledReason,
    }),
  );
}

/**
 * Reads git for a pressed row, bounded by the menu timeout: the action to run, whose null `url`
 * comes with the reason it cannot, such as no upstream or a timeout.
 */
export async function resolvePressedFileAction(
  id: string,
  lookup: Promise<SourceControlFileLink>,
  timeoutMs: number = FILE_LINK_TIMEOUT_MS,
): Promise<FileRemoteAction> {
  const actions = resolveFileRemoteActions(await settleFileLink(lookup, timeoutMs));
  return actions.find((action) => action.id === id) ?? actions[0]!;
}

interface CitedRange {
  readonly line: number;
  readonly endLine?: number;
}

/**
 * How a file cited at `ranges` asks for links: one range goes into the main links, and several
 * each get their own pair, since no single link covers them.
 */
export function fileLinkRanges<Range extends CitedRange>(
  ranges: ReadonlyArray<Range>,
): { readonly main: Range | undefined; readonly each: ReadonlyArray<Range> } {
  return ranges.length === 1 ? { main: ranges[0], each: [] } : { main: undefined, each: ranges };
}
