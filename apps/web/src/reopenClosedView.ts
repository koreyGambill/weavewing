import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { OpenPreviewMutation } from "./browser/openFileInPreview";
import type { ClosedView, ClosedViewEntry } from "./closedViewStore";
import type { PullRequestListPreferences } from "./components/pullRequest/pullRequestListPreferences";
import { openPreviewSession } from "./components/preview/openPreviewSession";
import {
  rightPanelHostRef,
  type RightPanelSurface,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

export interface ReopenOwnerState {
  environmentKnown: boolean;
  catalogReady: boolean;
  ownerExists: boolean;
  /** False only for a side chat tab whose thread is gone from the shell. */
  sideChatExists: boolean;
  shellLive: boolean;
  panel: ThreadRightPanelState;
}

export function planNextReopen(
  entries: readonly ClosedViewEntry[],
  ownerState: (entry: ClosedViewEntry) => ReopenOwnerState,
): { drop: ClosedViewEntry[]; restore: ClosedViewEntry | null } {
  const drop: ClosedViewEntry[] = [];
  for (const entry of entries) {
    const owner = ownerState(entry);
    if (!owner.environmentKnown) {
      if (!owner.catalogReady) break;
      drop.push(entry);
      continue;
    }
    if (!owner.ownerExists || !owner.sideChatExists) {
      if (owner.shellLive) continue;
      break;
    }
    const alreadyOpen =
      entry.kind === "panel-tab"
        ? owner.panel.isOpen && owner.panel.surfaces.some((s) => isSameTab(s, entry.surface))
        : owner.panel.surfaces.some(
            (s) => s.kind === "preview" && s.resourceId === entry.snapshot.tabId,
          );
    if (alreadyOpen) {
      drop.push(entry);
      continue;
    }
    return { drop, restore: entry };
  }
  return { drop, restore: null };
}

// Files tabs share ids across roots, so only one at the same root is the closed tab.
const isSameTab = (open: RightPanelSurface, closed: RightPanelSurface) =>
  open.id === closed.id &&
  (open.kind !== "files" || closed.kind !== "files" || open.root === closed.root);

type PullRequestsSearchLike = Partial<PullRequestListPreferences> & {
  repository?: string;
  number?: number;
  selectedProjectId?: ProjectId;
  selectedHost?: string;
  selectedEnvironmentId?: EnvironmentId;
};

export function pullRequestsSearchForRestore<S extends PullRequestsSearchLike>(
  previous: S,
  selected: RightPanelSurface | null,
): S & PullRequestListPreferences {
  const {
    repository: _repository,
    number: _number,
    selectedProjectId: _projectId,
    selectedHost: _host,
    selectedEnvironmentId: _environmentId,
    ...filters
  } = previous;
  return {
    ...filters,
    involvement: previous.involvement ?? "all",
    state: previous.state ?? "open",
    ...(selected?.kind === "pull-request"
      ? {
          repository: selected.repository,
          number: selected.number,
          selectedProjectId: selected.projectId as ProjectId,
          ...(selected.host === undefined ? {} : { selectedHost: selected.host }),
          ...(selected.environmentId === undefined
            ? {}
            : { selectedEnvironmentId: selected.environmentId as EnvironmentId }),
        }
      : {}),
  } as S & PullRequestListPreferences;
}

export async function reopenClosedView(
  view: ClosedView,
  options: {
    openPreview: OpenPreviewMutation;
    workspaceAvailable: boolean;
  },
): Promise<boolean> {
  const panels = useRightPanelStore.getState();
  const ref = view.threadRef;

  if (view.kind === "browser") {
    const url = view.snapshot.navStatus._tag === "Idle" ? undefined : view.snapshot.navStatus.url;
    const result = await openPreviewSession({
      openPreview: options.openPreview,
      threadRef: ref,
      ...(url === undefined ? {} : { url }),
      ...(view.snapshot.viewport === undefined ? {} : { viewport: view.snapshot.viewport }),
      ...(view.snapshot.profileId === undefined ? {} : { profileId: view.snapshot.profileId }),
      ...(view.snapshot.zoomFactor === undefined ? {} : { zoomFactor: view.snapshot.zoomFactor }),
      ...(view.snapshot.colorScheme === undefined
        ? {}
        : { colorScheme: view.snapshot.colorScheme }),
    });
    if (result._tag === "Failure") return false;
    panels.openBrowser(ref, result.value.tabId);
    return true;
  }
  const surface = view.surface;
  if (
    !options.workspaceAvailable &&
    (surface.kind === "files" || (surface.kind === "file" && !surface.attachment))
  )
    return false;
  switch (surface.kind) {
    case "preview":
      if (surface.resourceId !== null) return false;
      panels.openBrowser(ref, null);
      break;
    case "file":
      if (surface.attachment) panels.openAttachment(ref, surface.attachment);
      else {
        panels.openFile(ref, surface.relativePath, surface.revealLine ?? undefined);
        if (typeof surface.folderTrail === "string") {
          panels.navigateFolder(ref, surface.id, surface.relativePath, surface.folderTrail);
        }
      }
      break;
    case "files": {
      // An open workspace-root tab is the closed one already; any other Files tab is not.
      const workspaceRootOpen =
        surface.id === "files" &&
        selectThreadRightPanelState(panels.byThreadKey, rightPanelHostRef(ref)).surfaces.some(
          (current) => current.id === "files",
        );
      if (workspaceRootOpen) panels.activateSurface(ref, "files");
      else panels.restoreSurface(ref, surface);
      break;
    }
    case "device":
      panels.restoreSurface(ref, surface);
      break;
    case "pull-request":
      panels.restoreSurface(ref, surface);
      break;
    case "side-chat":
      panels.openSideChat(ref, surface.threadId);
      break;
    default:
      panels.restoreSurface(ref, surface);
  }
  return true;
}
