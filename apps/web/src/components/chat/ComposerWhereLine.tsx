import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectPickerPathLabel } from "@t3tools/client-runtime/project-picker";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { MapPinIcon } from "lucide-react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import type { DraftId } from "~/composerDraftStore";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "~/keybindings";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useProject } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";
import { DraftProjectPicker } from "./DraftProjectPicker";
import { openChangeThreadFolder } from "./changeThreadFolderDialogState";
import { useDraftPlaceSelection } from "./useDraftPlaceSelection";
import { useProjectPickerHomes } from "./useProjectPickerBrowse";

/**
 * The project and folder a thread runs in, under the composer. Before the first message it
 * opens the project picker; afterwards it opens Change folder. Muted at the default place.
 */
export function ComposerWhereLine({
  environmentId,
  threadId,
  projectId,
  worktreePath,
  isScratch,
  draftId,
  onEnvironmentChange,
  onComposerFocusRequest,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly isScratch: boolean;
  /** Set while the thread is an unsent draft. */
  readonly draftId: DraftId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly onComposerFocusRequest?: (() => void) | undefined;
}) {
  const projectRef = scopeProjectRef(environmentId, projectId);
  const project = useProject(projectRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeTarget = useThreadRouteTarget();
  const selection = useDraftPlaceSelection({ draftId, activeProjectRef: projectRef });
  const homes = useProjectPickerHomes([{ environmentId }], project !== null);
  const folder = worktreePath ?? project?.workspaceRoot ?? null;
  // Where New thread would start right now, from the one default-place resolver.
  const resolved = selection.defaultPlace;
  const atResolvedPlace =
    worktreePath === null &&
    (resolved.kind === "project"
      ? resolved.projectRef.environmentId === environmentId &&
        resolved.projectRef.projectId === projectId
      : resolved.kind === "scratch" && isScratch && resolved.environmentId === environmentId);
  // A fallback place is not the default: it is lit, and says why the default could not be used.
  const unavailable = atResolvedPlace && resolved.kind !== "none" ? resolved.unavailable : null;
  const atDefaultPlace = atResolvedPlace && unavailable === null;
  const shortcut = shortcutLabelForCommand(keybindings, "projectPicker.open");
  const threadRef = scopeThreadRef(environmentId, threadId);
  const started = draftId === null;
  const ownsRoute =
    routeTarget?.kind === "server" &&
    routeTarget.threadRef.environmentId === environmentId &&
    routeTarget.threadRef.threadId === threadId;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the picker key for a started thread, whose place changes through Change folder
  useEffect(() => {
    if (!started || !ownsRoute) return;
    return registerCommands(
      {
        "projectPicker.open": (event) => {
          event.preventDefault();
          openChangeThreadFolder(scopeThreadRef(environmentId, threadId));
        },
      },
      { when: () => !isCommandPaletteOpen() },
    );
  }, [started, ownsRoute, environmentId, threadId]);

  if (project === null || folder === null) return null;
  const folderLabel = projectPickerPathLabel(folder, homes.get(environmentId));
  const content = (
    <>
      <MapPinIcon className="shrink-0" />
      <ComposerContextLabel>
        <span
          className={cn(
            "flex min-w-0",
            atDefaultPlace ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {isScratch ? null : (
            // Phone widths drop the project name and keep the folder's tail.
            <span className="min-w-0 max-w-[60%] shrink-0 truncate whitespace-pre font-medium @max-md/composer-surface:hidden">
              {project.title}{" "}
            </span>
          )}
          <span className="flex min-w-0 font-mono">
            <MiddleTruncate value={folderLabel} showTitle={false} />
          </span>
        </span>
      </ComposerContextLabel>
    </>
  );
  const ariaLabel = isScratch ? `Folder ${folderLabel}` : `${project.title}, ${folderLabel}`;

  if (started) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size="xs"
              className="min-w-0 max-w-[35%] flex-initial justify-start"
              aria-label={`Change folder: ${ariaLabel}`}
              data-composer-context-control
              onClick={() => openChangeThreadFolder(threadRef)}
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipPopup>
          {folder} · Change folder{shortcut ? ` · ${shortcut}` : ""}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <>
      <DraftProjectPicker
        draftId={draftId}
        activeProjectRef={projectRef}
        environmentId={environmentId}
        label={isScratch ? folderLabel : project.title}
        truncateStart={isScratch}
        defaultPlace={{
          current: atDefaultPlace,
          makeDefault: () => selection.makeDefault({ projectRef, isScratch }),
        }}
        trigger={{
          content,
          ariaLabel: `Change project or folder: ${ariaLabel}`,
          className: "min-w-0 max-w-[35%] flex-initial justify-start",
        }}
        onSelect={selection.selectProject}
        onEnvironmentChange={onEnvironmentChange}
        onAddProject={selection.openAddProject}
        {...(onComposerFocusRequest ? { onClose: onComposerFocusRequest } : {})}
      />
      {unavailable === null ? null : (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <ComposerControl size="xs" aria-label={`Default is unavailable: ${unavailable}`} />
            }
          >
            Default unavailable
          </PopoverTrigger>
          <PopoverPopup side="top" padding="compact" width="sm">
            Default is unavailable: {unavailable}
          </PopoverPopup>
        </Popover>
      )}
      {atResolvedPlace || resolved.kind === "none" ? null : (
        <span className="shrink-0 text-xs">
          <InlineButton
            tone="muted"
            onClick={() => {
              void selection.moveToDefaultPlace().then(() => onComposerFocusRequest?.());
            }}
          >
            Use default place
          </InlineButton>
        </span>
      )}
    </>
  );
}
