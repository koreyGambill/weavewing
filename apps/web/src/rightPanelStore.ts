import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  type LinkTileDestination,
  type SavedTileNode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { buildTileLayoutFromSaved } from "./savedTileLayouts";
import {
  applyTileAction as reduceTileAction,
  CONVERSATION_TAB_ID,
  getTileGroups,
  isNewTab,
  parseTileLayout,
  renameTileTab,
  syncTileLayout,
  tileCloseFallback,
  type ThreadTileLayout,
  type TileAction,
} from "./threadTileLayout";

import { useClosedViewStore } from "./closedViewStore";
import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import type { ThreadPanelPresentation } from "./rightPanelLayout";
import type { ChatFileAttachment } from "./types";

const RIGHT_PANEL_KINDS = [
  "diff",
  "files",
  "file",
  "preview",
  "device",
  "terminal",
  "pull-request",
  "pull-requests",
  "side-chat",
  "notes",
  "questions",
] as const;

export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];
export type AddableRightPanelKind = Exclude<
  RightPanelKind,
  "file" | "preview" | "terminal" | "pull-request" | "side-chat"
>;

export type PullRequestDetailTab = "summary" | "guide" | "timeline" | "code";

export interface DeviceTabTarget {
  hostId: string;
  deviceId: string;
  platform: "ios" | "android";
  name: string;
}

type TerminalSurfaceLaunchContext = {
  readonly cwd: string;
  readonly worktreePath: string | null;
};

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | { id: "device" | `device:${string}`; kind: "device"; target?: DeviceTabTarget; title?: string }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      launchContext?: TerminalSurfaceLaunchContext;
    }
  | { id: "diff" | `diff:${string}`; kind: "diff" }
  | {
      id: "files" | `files:${string}`;
      kind: "files";
      /** Set when breadcrumbs moved a folder browser up to the workspace root. */
      folderTrail?: string;
      /** Absolute folder this tab's tree starts at; never set on the `files` id, which is the workspace root. */
      root?: string;
    }
  | {
      id: `file:${string}` | `attachment:${string}`;
      kind: "file";
      relativePath: string;
      revealLine: number | null;
      /** Last line of a linked range such as `:57-64`; absent for a single line. */
      revealEndLine?: number;
      revealRequestId: number;
      attachment?: ChatFileAttachment;
      /** Deepest workspace path retained for navigating back down after moving up. */
      folderTrail?: string;
    }
  | {
      id: `pull-request:${string}`;
      kind: "pull-request";
      /** Cross-environment lists can repeat project ids; thread panels inherit their ref's environment. */
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
      /** A clicked link waiting for the panel to show where it points; cleared once shown. */
      revealUrl?: string;
      detailTab?: PullRequestDetailTab;
    }
  | { id: "pull-requests" | `pull-requests:${string}`; kind: "pull-requests" }
  | { id: "notes" | `notes:${string}`; kind: "notes" }
  | { id: "questions" | `questions:${string}`; kind: "questions" }
  | {
      id: `related-thread:${string}`;
      kind: "related-thread";
      threadRef: ScopedThreadRef;
      relation: "fork" | "subagent";
      title: string;
    }
  | { id: `side-chat:${string}`; kind: "side-chat"; threadId: ThreadId };

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
const RIGHT_PANEL_STORAGE_VERSION = 17;

export const PULL_REQUESTS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("pull-requests-panel"),
  ThreadId.make("pull-requests-panel"),
);

const isPullRequestsPanelKey = (threadKey: string) => threadKey.endsWith(":pull-requests-panel");

export interface ThreadRightPanelState {
  tileLayout?: ThreadTileLayout;
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
  dismissedDeviceSurfaceIds?: string[];
  maximized?: true;
  proactiveDiffTurnId?: RunId;
  /** Set once a default layout laid this thread out; later defaults never touch it again. */
  defaultLayoutApplied?: true;
}

export interface ThreadPanelVisibility {
  inlineOpen?: boolean;
  popoverOpen: boolean;
}

interface RightPanelStoreState {
  applyTileAction: (ref: ScopedThreadRef, action: TileAction) => void;
  /** As a default, applies once per thread and only while it shows nothing but its chat. */
  applySavedTileLayout: (ref: ScopedThreadRef, saved: SavedTileNode, asDefault?: boolean) => void;
  byThreadKey: Record<string, ThreadRightPanelState>;
  pendingMaximizeThreadKey: string | null;
  requestMaximize: (ref: ScopedThreadRef) => void;
  consumeMaximizeRequest: (ref: ScopedThreadRef) => boolean;
  threadPanelVisibilityByThreadKey: Record<string, ThreadPanelVisibility>;
  userActionRevisionByThreadKey: Record<string, number>;
  closeRevisionByThreadKey: Record<string, number>;
  getUserActionRevision: (ref: ScopedThreadRef) => number;
  markUserAction: (ref: ScopedThreadRef) => number;
  /** Refused if the user chose a panel after expectedUserActionRevision was read. */
  openProactive: (
    ref: ScopedThreadRef,
    request:
      | Extract<RightPanelSurface, { kind: "pull-request" | "pull-requests" }>
      | { kind: "diff"; turnId: RunId },
    expectedUserActionRevision: number,
    activateExisting?: boolean,
  ) => boolean;
  add: (ref: ScopedThreadRef, kind: AddableRightPanelKind) => void;
  restoreSurface: (
    ref: ScopedThreadRef,
    surface: Exclude<RightPanelSurface, { kind: "terminal" }>,
  ) => void;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "side-chat">,
  ) => void;
  openSideChat: (ref: ScopedThreadRef, threadId: ThreadId) => void;
  openRelatedThread: (
    host: ScopedThreadRef,
    target: ScopedThreadRef,
    relation: "fork" | "subagent",
    title: string,
  ) => void;
  openDevice: (
    ref: ScopedThreadRef,
    target: DeviceTabTarget,
    automatic?: boolean,
    surfaceId?: string,
  ) => void;
  renameDevice: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  openBrowser: (
    ref: ScopedThreadRef,
    tabId: string | null,
    options?: { destination: LinkTileDestination; automatic?: boolean },
  ) => void;
  openFile: (
    ref: ScopedThreadRef,
    relativePath: string,
    reveal?: FileLineReveal,
    destination?: LinkTileDestination,
  ) => void;
  /** Re-roots one Files tab; null returns it to the workspace root. */
  setFilesRoot: (ref: ScopedThreadRef, surfaceId: string, root: string | null) => void;
  /** Opens a new Files tab beside the active one; null starts it at the workspace root. */
  openFilesAt: (ref: ScopedThreadRef, root: string | null) => void;
  /** Moves in place; "" opens the root explorer. folderTrail keeps the return path; keepSource opens beside the source. */
  navigateFolder: (
    ref: ScopedThreadRef,
    surfaceId: string,
    relativePath: string,
    folderTrail: string,
    keepSource?: boolean,
  ) => void;
  openAttachment: (
    ref: ScopedThreadRef,
    attachment: ChatFileAttachment,
    destination?: LinkTileDestination,
  ) => void;
  addPullRequest: (ref: ScopedThreadRef, target: Parameters<typeof pullRequestSurface>[0]) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    target: {
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
      /** A clicked link to reveal; reopening a surface passes only its `url`. */
      revealUrl?: string;
      detailTab?: PullRequestDetailTab;
    },
  ) => void;
  setPullRequestDetailTab: (
    ref: ScopedThreadRef,
    surfaceId: string,
    detailTab: PullRequestDetailTab,
  ) => void;
  /** Clears the surface's pending link only while it is still `revealUrl`. */
  settlePullRequestReveal: (ref: ScopedThreadRef, surfaceId: string, revealUrl: string) => void;
  openTerminal: (
    ref: ScopedThreadRef,
    terminalId: string,
    launchContext?: TerminalSurfaceLaunchContext,
  ) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  /** Agent-driven activation. Not a user action, so it does not move keyboard focus. */
  revealSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  moveSurface: (ref: ScopedThreadRef, surfaceId: string, toIndex: number) => void;
  reconcileBrowserSurfaces: (
    ref: ScopedThreadRef,
    tabIds: readonly string[],
    hiddenTabIds?: ReadonlySet<string>,
  ) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  setMaximized: (ref: ScopedThreadRef, maximized: boolean) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "side-chat">,
  ) => void;
  setThreadPanelOpen: (
    ref: ScopedThreadRef,
    presentation: ThreadPanelPresentation,
    open: boolean,
  ) => void;
  toggleThreadPanel: (ref: ScopedThreadRef, presentation: ThreadPanelPresentation) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const EMPTY_THREAD_PANEL_VISIBILITY: ThreadPanelVisibility = {
  popoverOpen: false,
};

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal" | "pull-request" | "side-chat">,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "pull-requests":
      return { id: "pull-requests", kind };
    case "device":
      return { id: "device", kind };
    case "notes":
      return { id: "notes", kind };
    case "questions":
      return { id: "questions", kind };
  }
};

const instanceSurface = (kind: AddableRightPanelKind): RightPanelSurface => {
  const surface = singletonSurface(kind);
  return { ...surface, id: `${kind}:${randomUUID()}` } as RightPanelSurface;
};

/** The unrooted singleton explorer gives way to the first file opened from it. */
const isStandaloneExplorer = (surface: RightPanelSurface) =>
  surface.kind === "files" && surface.id === "files" && surface.root === undefined;

const validAreaId = (id: string, kind: string) =>
  id === kind || (id.startsWith(`${kind}:`) && id.length > kind.length + 1);

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  reveal: { line: number | null; endLine: number | null },
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine: reveal.line,
  ...(reveal.endLine === null ? {} : { revealEndLine: reveal.endLine }),
  revealRequestId,
});

const attachmentSurface = (attachment: ChatFileAttachment): RightPanelSurface => ({
  id: `attachment:${attachment.id}`,
  kind: "file",
  relativePath: attachment.name,
  revealLine: null,
  revealRequestId: 0,
  attachment,
});

const terminalSurface = (
  terminalId: string,
  launchContext?: TerminalSurfaceLaunchContext,
): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  ...(launchContext ? { launchContext } : {}),
});

export type PullRequestSurface = Extract<RightPanelSurface, { kind: "pull-request" }>;

export function pullRequestSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
}): PullRequestSurface["id"] {
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${host}${encodeURIComponent(target.repository)}:${target.number}`;
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
  url?: string;
  detailTab?: PullRequestDetailTab;
}): PullRequestSurface {
  return {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    ...(typeof target.host === "string" ? { host: target.host.toLowerCase() } : {}),
    repository: target.repository,
    number: target.number,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
    ...(target.detailTab === undefined ? {} : { detailTab: target.detailTab }),
  };
}

/** A pending link belongs to the click that made it, not to a reload or a reopen. */
const withoutReveal = (surface: RightPanelSurface): RightPanelSurface => {
  if (surface.kind !== "pull-request" || surface.revealUrl === undefined) return surface;
  const { revealUrl: _pending, ...rest } = surface;
  return rest;
};

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
  fillChooser = true,
): ThreadRightPanelState => {
  const next = {
    ...current,
    isOpen: true,
    surfaces: current.surfaces.some((entry) => entry.id === surface.id)
      ? current.surfaces
      : [...current.surfaces, surface],
  };
  return activate ? activated(next, surface.id, fillChooser) : next;
};

function placeLinkedSurface(
  before: ThreadRightPanelState,
  after: ThreadRightPanelState,
  surfaceId: string,
  destination: LinkTileDestination | undefined,
  preserveChooser = false,
): ThreadRightPanelState {
  const layout = after.tileLayout;
  if (
    !layout ||
    !destination ||
    before.surfaces.some((surface) => surface.kind !== "preview" && surface.id === surfaceId)
  ) {
    return after;
  }

  const groups = getTileGroups(layout);
  const target =
    destination === "focused"
      ? (groups.find(
          (group) => group.id === (before.tileLayout?.focusedGroupId ?? groups[0]?.id),
        ) ?? groups[0])
      : groups[destination === "tile-1" ? 0 : 1];
  if (target) {
    return target.tabs.includes(surfaceId)
      ? after
      : {
          ...after,
          tileLayout: reduceTileAction(layout, {
            type: "move",
            tabId: surfaceId,
            targetGroupId: target.id,
            preserveChooser,
          }),
        };
  }

  const first = groups[0]!;
  const splitId = randomUUID();
  const split = reduceTileAction(layout, {
    type: "split",
    tabId: surfaceId,
    targetGroupId: first.id,
    groupId: randomUUID(),
    splitId,
    axis: "horizontal",
    side: "after",
  });
  return {
    ...after,
    tileLayout: reduceTileAction(split, { type: "resize", splitId, ratio: 0.62 }),
  };
}

const updateThreadStateMap = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  fillChooser = true,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const updated = updater(current);
  if (updated === current) return byThreadKey;
  const next = {
    ...updated,
    tileLayout: syncTileLayout(
      updated.tileLayout ?? current.tileLayout,
      current.surfaces.map((surface) => surface.id),
      updated.surfaces.map((surface) => surface.id),
      updated.activeSurfaceId,
      updated.isOpen && (updated.activeSurfaceId !== current.activeSurfaceId || !current.isOpen),
      fillChooser,
    ),
  };
  return { ...byThreadKey, [threadKey]: next };
};

const updateThreadPanelVisibilityMap = (
  byThreadKey: Record<string, ThreadPanelVisibility>,
  threadKey: string,
  updater: (current: ThreadPanelVisibility) => ThreadPanelVisibility,
): Record<string, ThreadPanelVisibility> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_PANEL_VISIBILITY;
  const next = updater(current);
  if (next.inlineOpen === undefined && !next.popoverOpen) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

type RightPanelStoreData = Pick<
  RightPanelStoreState,
  "byThreadKey" | "threadPanelVisibilityByThreadKey"
>;

const updateThread = (
  state: RightPanelStoreData,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  fillChooser = true,
): RightPanelStoreData => {
  const current = state.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const byThreadKey = updateThreadStateMap(state.byThreadKey, threadKey, updater, fillChooser);
  const next = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  let threadPanelVisibilityByThreadKey = state.threadPanelVisibilityByThreadKey;

  if (!current.isOpen && next.isOpen) {
    threadPanelVisibilityByThreadKey = updateThreadPanelVisibilityMap(
      threadPanelVisibilityByThreadKey,
      threadKey,
      (visibility) => (visibility.popoverOpen ? { ...visibility, popoverOpen: false } : visibility),
    );
  } else if (current.isOpen && !next.isOpen) {
    threadPanelVisibilityByThreadKey = updateThreadPanelVisibilityMap(
      threadPanelVisibilityByThreadKey,
      threadKey,
      (visibility) =>
        visibility.popoverOpen && !visibility.inlineOpen
          ? { ...visibility, inlineOpen: true }
          : visibility,
    );
  }

  return { byThreadKey, threadPanelVisibilityByThreadKey };
};

const automaticUpdate = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, updater, false),
});

// A side chat pane has no panel of its own, so its panel actions open in its parent's panel.
const panelHosts = new Map<string, ScopedThreadRef>();

/** Routes `guest`'s panel actions to `host`'s panel until the returned cleanup runs. */
export function hostRightPanel(guest: ScopedThreadRef, host: ScopedThreadRef): () => void {
  const guestKey = scopedThreadKey(guest);
  panelHosts.set(guestKey, host);
  return () => {
    if (panelHosts.get(guestKey) === host) panelHosts.delete(guestKey);
  };
}

/** The thread whose panel shows `ref`'s panel actions, so it also owns their browser tabs. */
export function rightPanelHostRef(ref: ScopedThreadRef): ScopedThreadRef {
  let host = panelHosts.get(scopedThreadKey(ref));
  while (host !== undefined) {
    ref = host;
    host = panelHosts.get(scopedThreadKey(ref));
  }
  return ref;
}

const userAction = (
  state: RightPanelStoreState,
  guestKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  closesView = false,
): Partial<RightPanelStoreState> => {
  const host = panelHosts.get(guestKey);
  const threadKey = host === undefined ? guestKey : scopedThreadKey(rightPanelHostRef(host));
  return userActionOnThread(state, threadKey, updater, closesView);
};

const userActionOnThread = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  closesView: boolean,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, (current) => {
    const next = updater(current);
    if (next === current) return current;
    const removedDevices = current.surfaces.filter(
      (surface) =>
        surface.kind === "device" && !next.surfaces.some((entry) => entry.id === surface.id),
    );
    if (removedDevices.length === 0) return next;
    return {
      ...next,
      dismissedDeviceSurfaceIds: [
        ...new Set([
          ...(next.dismissedDeviceSurfaceIds ?? []),
          ...removedDevices.map((surface) => surface.id),
        ]),
      ],
    };
  }),
  userActionRevisionByThreadKey: {
    ...state.userActionRevisionByThreadKey,
    [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
  },
  ...(closesView
    ? {
        closeRevisionByThreadKey: {
          ...state.closeRevisionByThreadKey,
          [threadKey]: (state.closeRevisionByThreadKey[threadKey] ?? 0) + 1,
        },
      }
    : {}),
});

const activated = (
  current: ThreadRightPanelState,
  surfaceId: string,
  fillChooser = true,
): ThreadRightPanelState =>
  current.surfaces.some((surface) => surface.id === surfaceId)
    ? {
        ...current,
        isOpen: true,
        activeSurfaceId: surfaceId,
        tileLayout: syncTileLayout(
          current.tileLayout,
          current.surfaces.map((surface) => surface.id),
          current.surfaces.map((surface) => surface.id),
          surfaceId,
          true,
          fillChooser,
        ),
      }
    : current;

const closeAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => userAction(state, threadKey, updater, true);

/** A line, or `line` through `endLine`, to scroll to and flash when a file opens. */
export interface FileLineReveal {
  readonly line?: number | undefined;
  readonly endLine?: number | undefined;
}

function normalizeRevealLine(line: unknown): number | null {
  if (typeof line !== "number" || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

function normalizeReveal(reveal: { readonly line?: unknown; readonly endLine?: unknown }): {
  line: number | null;
  endLine: number | null;
} {
  const line = normalizeRevealLine(reveal.line);
  const endLine = normalizeRevealLine(reveal.endLine);
  return { line, endLine: line !== null && endLine !== null && endLine > line ? endLine : null };
}

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
  threadPanelVisibilityByThreadKey: Record<string, ThreadPanelVisibility>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {}, threadPanelVisibilityByThreadKey: {} };
  }
  const byThreadKey =
    "byThreadKey" in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === "object"
      ? Object.fromEntries(
          Object.entries(persistedState.byThreadKey as Record<string, ThreadRightPanelState>)
            .filter(([threadKey]) => !isPullRequestsPanelKey(threadKey))
            .map(([threadKey, threadState]) => {
              const validThreadState =
                threadState && typeof threadState === "object" ? threadState : null;
              const surfaces = Array.isArray(validThreadState?.surfaces)
                ? validThreadState.surfaces.flatMap<RightPanelSurface>((surface) => {
                    const kind = (surface as { kind?: string }).kind;
                    if (
                      kind === "plan" ||
                      kind === "agents" ||
                      kind === "environments" ||
                      kind === "inspect" ||
                      kind === "reviews"
                    )
                      return [];
                    if (surface.kind === "notes")
                      return validAreaId(surface.id, "notes") ? [surface] : [];
                    if (surface.kind === "questions")
                      return validAreaId(surface.id, "questions") ? [surface] : [];
                    if (
                      (surface.kind === "file" || surface.kind === "files") &&
                      "folderTrail" in surface &&
                      typeof surface.folderTrail !== "string"
                    ) {
                      const { folderTrail: _invalid, ...rest } = surface;
                      surface = rest;
                    }
                    if (surface.kind === "file") {
                      const { revealEndLine: _persistedEndLine, ...rest } = surface;
                      const reveal = normalizeReveal({
                        line: surface.revealLine,
                        endLine: surface.revealEndLine,
                      });
                      const revealRequestId =
                        typeof surface.revealRequestId === "number" &&
                        Number.isSafeInteger(surface.revealRequestId) &&
                        surface.revealRequestId >= 0
                          ? surface.revealRequestId
                          : 0;
                      return [
                        {
                          ...rest,
                          revealLine: reveal.line,
                          ...(reveal.endLine === null ? {} : { revealEndLine: reveal.endLine }),
                          revealRequestId,
                        },
                      ];
                    }
                    if (surface.kind === "pull-request") {
                      if (
                        typeof surface.projectId !== "string" ||
                        typeof surface.repository !== "string" ||
                        typeof surface.number !== "number" ||
                        !Number.isSafeInteger(surface.number) ||
                        surface.number < 1
                      ) {
                        return [];
                      }
                      const { environmentId, ...rest } = surface;
                      const restored = pullRequestSurface({
                        ...rest,
                        ...(typeof environmentId === "string" ? { environmentId } : {}),
                      });
                      return [
                        {
                          ...restored,
                          id: surface.id.startsWith(`${restored.id}:view:`)
                            ? surface.id
                            : restored.id,
                        },
                      ];
                    }
                    if (surface.kind !== "terminal") return [surface];
                    if (
                      !("resourceId" in surface) ||
                      typeof surface.resourceId !== "string" ||
                      surface.id !== `terminal:${surface.resourceId}`
                    ) {
                      return [];
                    }
                    if ("launchContext" in surface) {
                      const context = surface.launchContext;
                      if (
                        context === null ||
                        typeof context !== "object" ||
                        typeof context.cwd !== "string" ||
                        (context.worktreePath !== null && typeof context.worktreePath !== "string")
                      ) {
                        const { launchContext: _invalid, ...rest } = surface;
                        surface = rest;
                      }
                    }
                    const terminalIds =
                      "terminalIds" in surface && Array.isArray(surface.terminalIds)
                        ? [
                            ...new Set(
                              surface.terminalIds.filter(
                                (terminalId): terminalId is string =>
                                  typeof terminalId === "string",
                              ),
                            ),
                          ]
                        : [surface.resourceId];
                    const ids = terminalIds.length > 0 ? terminalIds : [surface.resourceId];
                    return ids.map((terminalId) => ({
                      ...terminalSurface(terminalId, surface.launchContext),
                    }));
                  })
                : [];
              const oldActive = validThreadState?.surfaces?.find(
                (surface) => surface.id === validThreadState.activeSurfaceId,
              );
              const rawActiveSurfaceId =
                oldActive?.kind === "terminal"
                  ? `terminal:${
                      "activeTerminalId" in oldActive &&
                      typeof oldActive.activeTerminalId === "string"
                        ? oldActive.activeTerminalId
                        : oldActive.resourceId
                    }`
                  : validThreadState?.activeSurfaceId;
              const persistedActiveSurfaceId = surfaces.some(
                (surface) => surface.id === rawActiveSurfaceId,
              )
                ? (rawActiveSurfaceId ?? null)
                : rawActiveSurfaceId === "pull-request"
                  ? (surfaces.find((surface) => surface.kind === "pull-request")?.id ?? null)
                  : null;
              const isOpen =
                surfaces.length > 0 &&
                (typeof validThreadState?.isOpen === "boolean"
                  ? validThreadState.isOpen
                  : persistedActiveSurfaceId !== null);
              const activeSurfaceId =
                persistedActiveSurfaceId ??
                (isOpen || rawActiveSurfaceId === "agents" ? (surfaces[0]?.id ?? null) : null);
              const tileLayout = parseTileLayout(validThreadState?.tileLayout);
              return [
                threadKey,
                {
                  isOpen,
                  surfaces,
                  activeSurfaceId,
                  ...(tileLayout
                    ? {
                        tileLayout: syncTileLayout(
                          tileLayout,
                          [],
                          surfaces.map((surface) => surface.id),
                          activeSurfaceId,
                          false,
                        ),
                      }
                    : {}),
                  ...(typeof validThreadState?.proactiveDiffTurnId === "string"
                    ? { proactiveDiffTurnId: RunId.make(validThreadState.proactiveDiffTurnId) }
                    : {}),
                  ...(Array.isArray(validThreadState?.dismissedDeviceSurfaceIds)
                    ? {
                        dismissedDeviceSurfaceIds:
                          validThreadState.dismissedDeviceSurfaceIds.filter(
                            (id): id is string => typeof id === "string",
                          ),
                      }
                    : {}),
                  ...(validThreadState?.maximized === true ? { maximized: true as const } : {}),
                  ...(validThreadState?.defaultLayoutApplied === true
                    ? { defaultLayoutApplied: true as const }
                    : {}),
                },
              ];
            }),
        )
      : {};
  const threadPanelVisibilityByThreadKey =
    "threadPanelVisibilityByThreadKey" in persistedState &&
    persistedState.threadPanelVisibilityByThreadKey &&
    typeof persistedState.threadPanelVisibilityByThreadKey === "object"
      ? Object.fromEntries(
          Object.entries(
            persistedState.threadPanelVisibilityByThreadKey as Record<string, unknown>,
          ).flatMap(([threadKey, value]) => {
            if (!value || typeof value !== "object" || !("inlineOpen" in value)) return [];
            return typeof value.inlineOpen === "boolean"
              ? [[threadKey, { inlineOpen: value.inlineOpen, popoverOpen: false }]]
              : [];
          }),
        )
      : {};
  return { byThreadKey, threadPanelVisibilityByThreadKey };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      pendingMaximizeThreadKey: null,
      requestMaximize: (ref) => set({ pendingMaximizeThreadKey: scopedThreadKey(ref) }),
      consumeMaximizeRequest: (ref) => {
        if (get().pendingMaximizeThreadKey !== scopedThreadKey(ref)) return false;
        set({ pendingMaximizeThreadKey: null });
        return true;
      },
      applyTileAction: (ref, action) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            tileLayout: reduceTileAction(
              syncTileLayout(
                current.tileLayout,
                [],
                current.surfaces.map((surface) => surface.id),
                current.activeSurfaceId,
                false,
              ),
              action,
            ),
          })),
        ),
      applySavedTileLayout: (ref, saved, asDefault = false) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const untouched =
              current.surfaces.length === 0 &&
              (!current.tileLayout ||
                getTileGroups(current.tileLayout)
                  .flatMap((group) => group.tabs)
                  .join() === CONVERSATION_TAB_ID);
            if (asDefault && (current.defaultLayoutApplied || !untouched)) return current;
            const surfaceIds = current.surfaces.map((surface) => surface.id);
            const laidOut = current.tileLayout
              ? getTileGroups(current.tileLayout)
                  .flatMap((group) => group.tabs)
                  .filter((id) => !isNewTab(id))
              : [];
            return {
              ...current,
              ...(asDefault ? { defaultLayoutApplied: true as const } : {}),
              tileLayout: buildTileLayoutFromSaved(
                saved,
                [...new Set([...laidOut, ...surfaceIds])],
                randomUUID,
              ),
            };
          }),
        ),
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
      getUserActionRevision: (ref) =>
        get().userActionRevisionByThreadKey[scopedThreadKey(ref)] ?? 0,
      markUserAction: (ref) => {
        const revision = get().getUserActionRevision(ref) + 1;
        set((state) => ({
          userActionRevisionByThreadKey: {
            ...state.userActionRevisionByThreadKey,
            [scopedThreadKey(ref)]: revision,
          },
        }));
        return revision;
      },
      openProactive: (ref, request, expectedUserActionRevision, activateExisting = false) => {
        let opened = false;
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (request.kind === "diff") {
            const current = selectThreadRightPanelState(state.byThreadKey, ref);
            if (current.proactiveDiffTurnId === request.turnId) return state;
            const activePanel = selectActiveRightPanel(state.byThreadKey, ref);
            const pullRequestActive =
              activePanel === "pull-request" || activePanel === "pull-requests";
            opened =
              (state.userActionRevisionByThreadKey[threadKey] ?? 0) ===
                expectedUserActionRevision &&
              activePanel !== "diff" &&
              !pullRequestActive;
            // Record the offer even when refused, so a revisit does not retry this turn.
            return automaticUpdate(state, threadKey, (thread) => ({
              ...(opened ? upsertSurface(thread, singletonSurface("diff"), true, false) : thread),
              proactiveDiffTurnId: request.turnId,
            }));
          }
          if (
            (state.userActionRevisionByThreadKey[threadKey] ?? 0) !== expectedUserActionRevision
          ) {
            return state;
          }
          // Keep an existing PR tab where the user left it when revisiting a thread.
          if (
            !activateExisting &&
            selectThreadRightPanelState(state.byThreadKey, ref).surfaces.some(
              (entry) => entry.id === request.id,
            )
          ) {
            return state;
          }
          opened = true;
          return automaticUpdate(state, threadKey, (current) =>
            upsertSurface(current, request, true, false),
          );
        });
        return opened;
      },
      add: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, instanceSurface(kind)),
          ),
        ),
      restoreSurface: (ref, surface) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(
              current,
              // A Files tab's id may now belong to another tab, and `files` is only the workspace root.
              surface.kind === "files" &&
                (current.surfaces.some((entry) => entry.id === surface.id) ||
                  (surface.id === "files" && surface.root !== undefined))
                ? { ...surface, id: `files:${randomUUID()}` }
                : surface,
            ),
          ),
        ),
      open: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            const existing = current.surfaces.find(
              (surface) => surface.kind === kind && kind !== "device",
            );
            return upsertSurface(current, existing ?? singletonSurface(kind));
          }),
        ),
      openDevice: (ref, target, automatic = false, surfaceId) =>
        set((state) =>
          (automatic ? automaticUpdate : userAction)(state, scopedThreadKey(ref), (current) => {
            if (
              surfaceId !== undefined &&
              current.surfaces.some(
                (surface) => surface.id === surfaceId && surface.kind === "device",
              )
            ) {
              return activated(
                {
                  ...current,
                  surfaces: current.surfaces.map((surface) =>
                    surface.id === surfaceId && surface.kind === "device"
                      ? { ...surface, target }
                      : surface,
                  ),
                },
                surfaceId,
              );
            }
            const id =
              `device:${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.deviceId)}` as const;
            if (automatic && current.dismissedDeviceSurfaceIds?.includes(id)) return current;
            const surface: RightPanelSurface = { id, kind: "device", target };
            const existing = current.surfaces.find((entry) => entry.id === id);
            const surfaces = existing
              ? current.surfaces.filter((entry) => entry.id !== "device")
              : current.surfaces.map((entry) => (entry.id === "device" ? surface : entry));
            return upsertSurface(
              {
                ...current,
                surfaces,
                dismissedDeviceSurfaceIds: (current.dismissedDeviceSurfaceIds ?? []).filter(
                  (entry) => entry !== id,
                ),
              },
              existing ?? surface,
            );
          }),
        ),
      openSideChat: (ref, threadId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, { id: `side-chat:${threadId}`, kind: "side-chat", threadId }),
          ),
        ),
      openRelatedThread: (host, threadRef, relation, title) =>
        set((state) =>
          userAction(state, scopedThreadKey(host), (current) => {
            const id = `related-thread:${scopedThreadKey(threadRef)}` as const;
            const existing = current.surfaces.some((surface) => surface.id === id);
            const next = upsertSurface(current, {
              id,
              kind: "related-thread",
              threadRef,
              relation,
              title,
            });
            if (existing) return next;
            const layout = syncTileLayout(
              current.tileLayout,
              current.surfaces.map((surface) => surface.id),
              next.surfaces.map((surface) => surface.id),
              id,
              false,
              false,
            );
            const main = getTileGroups(layout).find((group) =>
              group.tabs.includes(CONVERSATION_TAB_ID),
            );
            if (!main) return next;
            const beside = reduceTileAction(layout, {
              type: "move",
              tabId: id,
              targetGroupId: main.id,
              index: main.tabs.indexOf(CONVERSATION_TAB_ID) + 1,
            });
            return {
              ...next,
              tileLayout: reduceTileAction(beside, {
                type: "activate",
                groupId: main.id,
                tabId: id,
              }),
            };
          }),
        ),
      renameDevice: (ref, surfaceId, title) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "device"
                ? { ...surface, title: title.trim() || surface.target?.name || "Device" }
                : surface,
            ),
          })),
        ),
      openBrowser: (ref, tabId, options) =>
        set((state) => {
          const update = options?.automatic ? automaticUpdate : userAction;
          const host = rightPanelHostRef(ref);
          return update(state, scopedThreadKey(host), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            const fillChooser = !options;
            const next = upsertSurface(
              { ...current, surfaces: withoutPlaceholder },
              surface,
              true,
              fillChooser,
            );
            return placeLinkedSurface(
              current,
              next,
              surface.id,
              options?.destination,
              options?.automatic,
            );
          });
        }),
      addPullRequest: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = pullRequestSurface(target);
            return upsertSurface(current, { ...surface, id: `${surface.id}:view:${randomUUID()}` });
          }),
        ),
      openPullRequest: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = pullRequestSurface(target);
            const next = upsertSurface(current, surface);
            const { url, revealUrl } = target;
            if (!url && !revealUrl) return next;
            return {
              ...next,
              surfaces: next.surfaces.map((entry) => {
                if (entry.id !== surface.id || entry.kind !== "pull-request") return entry;
                // A later link replaces one not yet shown.
                const { revealUrl: _previous, ...rest } = entry;
                return { ...rest, ...surface, ...(revealUrl ? { revealUrl } : {}) };
              }),
            };
          }),
        ),
      setPullRequestDetailTab: (ref, surfaceId, detailTab) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const existing = state.byThreadKey[threadKey]?.surfaces.find(
            (surface) => surface.id === surfaceId,
          );
          if (existing?.kind !== "pull-request" || (existing.detailTab ?? "summary") === detailTab)
            return state;
          return automaticUpdate(state, threadKey, (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "pull-request"
                ? { ...surface, detailTab }
                : surface,
            ),
          }));
        }),
      settlePullRequestReveal: (ref, surfaceId, revealUrl) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const existing = state.byThreadKey[threadKey]?.surfaces.find(
            (surface) => surface.id === surfaceId,
          );
          if (existing?.kind !== "pull-request" || existing.revealUrl !== revealUrl) return state;
          return automaticUpdate(state, threadKey, (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId ? withoutReveal(surface) : surface,
            ),
          }));
        }),
      openFile: (ref, requestedPath, reveal, destination) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (requestedPath === ".") {
              const surface = singletonSurface("files");
              return placeLinkedSurface(
                current,
                upsertSurface(current, surface, true, !destination),
                surface.id,
                destination,
              );
            }
            // Workspace entry paths use '/', including on Windows.
            const relativePath = /^[A-Za-z]:\/+$/.test(requestedPath)
              ? requestedPath
              : requestedPath.replace(/\/+$/, "") || requestedPath;
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => !isStandaloneExplorer(surface),
            );
            const surfaceId = `file:${relativePath}` as const;
            const existing = withoutStandaloneExplorer.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeReveal(reveal ?? {}),
              (existing?.revealRequestId ?? 0) + 1,
            );
            const next = activated(
              {
                ...current,
                surfaces: existing
                  ? withoutStandaloneExplorer.map((entry) =>
                      entry.id === surface.id ? surface : entry,
                    )
                  : [...withoutStandaloneExplorer, surface],
              },
              surface.id,
              !destination,
            );
            return placeLinkedSurface(current, next, surface.id, destination);
          }),
        ),
      navigateFolder: (ref, surfaceId, relativePath, folderTrail, keepSource = false) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const trail = folderTrail === relativePath ? {} : { folderTrail };
            const target: RightPanelSurface =
              relativePath === ""
                ? { ...singletonSurface("files"), ...trail }
                : { ...fileSurface(relativePath, { line: null, endLine: null }, 1), ...trail };
            const source = current.surfaces[index]!;
            const existing = current.surfaces.some(
              (surface, i) => i !== index && surface.id === target.id,
            );
            const surfaces = current.surfaces.flatMap((surface, i) => {
              if (i === index) {
                const kept = keepSource ? [source] : [];
                return existing ? kept : [...kept, target];
              }
              return !existing && target.kind === "file" && isStandaloneExplorer(surface)
                ? []
                : [surface];
            });
            return activated({ ...current, surfaces }, target.id);
          }),
        ),
      setFilesRoot: (ref, surfaceId, root) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const existing = current.surfaces.find((surface) => surface.id === surfaceId);
            if (existing?.kind !== "files" || (existing.root ?? null) === root) return current;
            // The breadcrumb trail is relative to the old root.
            const { root: _previous, folderTrail: _trail, ...rest } = existing;
            // `files` stays free for the workspace root, so a re-rooted default tab takes its own id.
            const id = root !== null && surfaceId === "files" ? `files:${randomUUID()}` : surfaceId;
            const surface = {
              ...rest,
              id,
              ...(root === null ? {} : { root }),
            } as RightPanelSurface;
            return {
              ...current,
              surfaces: current.surfaces.map((entry) => (entry.id === surfaceId ? surface : entry)),
              activeSurfaceId: current.activeSurfaceId === surfaceId ? id : current.activeSurfaceId,
              ...(current.tileLayout && id !== surfaceId
                ? { tileLayout: renameTileTab(current.tileLayout, surfaceId, id) }
                : {}),
            };
          }),
        ),
      openFilesAt: (ref, root) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, {
              ...instanceSurface("files"),
              ...(root === null ? {} : { root }),
            } as RightPanelSurface),
          ),
        ),
      openAttachment: (ref, attachment, destination) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => !isStandaloneExplorer(surface),
            );
            const surface = attachmentSurface(attachment);
            const next = upsertSurface(
              { ...current, surfaces: withoutStandaloneExplorer },
              surface,
              true,
              !destination,
            );
            return placeLinkedSurface(current, next, surface.id, destination);
          }),
        ),
      openTerminal: (ref, terminalId, launchContext) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId, launchContext)),
          ),
        ),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            if (surface.resourceId !== terminalId) return current;
            const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
            const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
            const groupFallback = tileCloseFallback(current.tileLayout, surfaceId);
            const fallback =
              surfaces.find((surface) => surface.id === groupFallback) ??
              surfaces[Math.min(index, surfaces.length - 1)] ??
              null;
            return {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
              activeSurfaceId:
                current.activeSurfaceId === surfaceId
                  ? (fallback?.id ?? null)
                  : current.activeSurfaceId,
            };
          }),
        ),
      activateSurface: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => activated(current, surfaceId)),
        ),
      revealSurface: (ref, surfaceId) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) =>
            activated(current, surfaceId, false),
          ),
        ),
      closeSurface: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            const next = {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
            };
            if (current.activeSurfaceId !== surfaceId) {
              return next;
            }
            const groupFallback = tileCloseFallback(current.tileLayout, surfaceId);
            const fallback =
              surfaces.find((surface) => surface.id === groupFallback) ??
              surfaces[Math.min(index, surfaces.length - 1)] ??
              null;
            return {
              ...next,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        ),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        ),
      closeAllSurfaces: (ref) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        ),
      moveSurface: (ref, surfaceId, toIndex) =>
        set((state) =>
          updateThread(state, scopedThreadKey(ref), (current) => {
            const fromIndex = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (fromIndex < 0 || fromIndex === toIndex) return current;
            const surfaces = [...current.surfaces];
            surfaces.splice(toIndex, 0, ...surfaces.splice(fromIndex, 1));
            return { ...current, surfaces };
          }),
        ),
      reconcileBrowserSurfaces: (ref, tabIds, hiddenTabIds) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const kept = current.surfaces.filter(
              (surface) =>
                surface.kind !== "preview" ||
                (surface.id !== "browser:new" && validIds.has(surface.id)),
            );
            const knownIds = new Set(kept.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`) && !hiddenTabIds?.has(tabId))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...kept, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            // A closed session tab was the last surface: hide the panel rather than leave it on
            // the empty picker, as a user close would. A dropped `browser:new` placeholder does not count.
            const closedLastSessionTab =
              surfaces.length === 0 &&
              current.surfaces.some((surface) => surface.kind === "preview" && surface.resourceId);
            return {
              ...current,
              isOpen: closedLastSessionTab ? false : current.isOpen,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        ),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) =>
                surface.kind !== "files" &&
                (surface.kind !== "file" || surface.attachment !== undefined),
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: surfaces.length > 0 ? current.isOpen : false,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            };
          }),
        ),
      show: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        ),
      close: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        ),
      setMaximized: (ref, maximized) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            if ((current.maximized ?? false) === maximized) return current;
            const { maximized: _maximized, ...rest } = current;
            return maximized ? { ...rest, maximized: true } : rest;
          }),
        ),
      toggleVisibility: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        ),
      toggle: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            const existing = current.surfaces.find(
              (surface) => surface.kind === kind && kind !== "device",
            );
            return upsertSurface(current, existing ?? singletonSurface(kind));
          }),
        ),
      setThreadPanelOpen: (ref, presentation, open) =>
        set((state) => ({
          threadPanelVisibilityByThreadKey: updateThreadPanelVisibilityMap(
            state.threadPanelVisibilityByThreadKey,
            scopedThreadKey(ref),
            (visibility) => {
              const key = presentation === "inline" ? "inlineOpen" : "popoverOpen";
              return visibility[key] === open ? visibility : { ...visibility, [key]: open };
            },
          ),
        })),
      toggleThreadPanel: (ref, presentation) =>
        set((state) => ({
          threadPanelVisibilityByThreadKey: updateThreadPanelVisibilityMap(
            state.threadPanelVisibilityByThreadKey,
            scopedThreadKey(ref),
            (visibility) =>
              presentation === "inline"
                ? { ...visibility, inlineOpen: !visibility.inlineOpen }
                : visibility.popoverOpen
                  ? { ...visibility, inlineOpen: false, popoverOpen: false }
                  : { ...visibility, popoverOpen: true },
          ),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.threadPanelVisibilityByThreadKey) &&
            !(threadKey in state.userActionRevisionByThreadKey) &&
            !(threadKey in state.closeRevisionByThreadKey)
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _visibility, ...threadPanelVisibilityByThreadKey } =
            state.threadPanelVisibilityByThreadKey;
          const { [threadKey]: _revision, ...userActionRevisionByThreadKey } =
            state.userActionRevisionByThreadKey;
          const { [threadKey]: _closeRevision, ...closeRevisionByThreadKey } =
            state.closeRevisionByThreadKey;
          return {
            byThreadKey,
            threadPanelVisibilityByThreadKey,
            userActionRevisionByThreadKey,
            closeRevisionByThreadKey,
          };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).flatMap(([threadKey, threadState]) =>
            isPullRequestsPanelKey(threadKey)
              ? []
              : [
                  [
                    threadKey,
                    {
                      ...threadState,
                      surfaces: threadState.surfaces
                        .filter((surface) => surface.kind !== "related-thread")
                        .map(withoutReveal),
                    },
                  ],
                ],
          ),
        ),
        threadPanelVisibilityByThreadKey: Object.fromEntries(
          Object.entries(state.threadPanelVisibilityByThreadKey).flatMap(
            ([threadKey, visibility]) =>
              visibility.inlineOpen === undefined
                ? []
                : [[threadKey, { inlineOpen: visibility.inlineOpen, popoverOpen: false }]],
          ),
        ),
      }),
      migrate: migratePersistedRightPanelState,
      merge: (persisted, current) => ({
        ...current,
        ...migratePersistedRightPanelState(persisted),
      }),
    },
  ),
);

useRightPanelStore.subscribe((next, previous) => {
  if (next.closeRevisionByThreadKey === previous.closeRevisionByThreadKey) return;
  for (const [threadKey, revision] of Object.entries(next.closeRevisionByThreadKey)) {
    if (revision === previous.closeRevisionByThreadKey[threadKey]) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef) continue;
    const before = previous.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const after = next.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const removed = before.surfaces.filter(
      (surface) => !after.surfaces.some((entry) => entry.id === surface.id),
    );
    const closedInOrder = [
      ...removed.filter((surface) => surface.id !== before.activeSurfaceId),
      ...removed.filter((surface) => surface.id === before.activeSurfaceId),
    ];
    for (const surface of closedInOrder.map(withoutReveal)) {
      if (
        surface.kind === "terminal" ||
        (surface.kind === "preview" && surface.resourceId !== null)
      )
        continue;
      useClosedViewStore.getState().remember({ kind: "panel-tab", threadRef, surface });
    }
  }
});

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectThreadPanelVisibility(
  byThreadKey: Record<string, ThreadPanelVisibility>,
  ref: ScopedThreadRef | null | undefined,
): ThreadPanelVisibility {
  const visibility = ref ? byThreadKey[scopedThreadKey(ref)] : undefined;
  return visibility ?? EMPTY_THREAD_PANEL_VISIBILITY;
}

export function selectThreadPanelOpen(
  byThreadKey: Record<string, ThreadPanelVisibility>,
  ref: ScopedThreadRef | null | undefined,
  presentation: ThreadPanelPresentation,
): boolean {
  const visibility = selectThreadPanelVisibility(byThreadKey, ref);
  return presentation === "inline" ? (visibility.inlineOpen ?? false) : visibility.popoverOpen;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface["kind"] | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byThreadKey, ref);
}

export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

const derivedTileLayouts = new WeakMap<ThreadRightPanelState, ThreadTileLayout>();

export function selectThreadTileLayout(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadTileLayout {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (state.tileLayout) return state.tileLayout;
  const cached = derivedTileLayouts.get(state);
  if (cached) return cached;
  const layout = syncTileLayout(
    undefined,
    [],
    state.surfaces.map((surface) => surface.id),
    state.activeSurfaceId,
    state.isOpen,
  );
  derivedTileLayouts.set(state, layout);
  return layout;
}
