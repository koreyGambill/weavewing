import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectPickerPathLabel } from "@t3tools/client-runtime/project-picker";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import type { DraftId } from "~/composerDraftStore";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useProject } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { InlineButton } from "../ui/button";
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
  draftId,
  onEnvironmentChange,
  onComposerFocusRequest,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
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
  const scratchRoot = selection.scratchWorkspaceRootFor(environmentId);
  const folder = worktreePath ?? project?.workspaceRoot ?? null;
  const isScratch = project !== null && isScratchProject(project, scratchRoot);
  const atDefaultPlace =
    isScratch && environmentId === selection.defaultEnvironmentId && worktreePath === null;
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
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5",
        atDefaultPlace ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {isScratch ? null : <span className="shrink-0 font-medium">{project.title}</span>}
      <span className="min-w-0 truncate font-mono">{folderLabel}</span>
    </span>
  );
  const ariaLabel = isScratch ? `Folder ${folderLabel}` : `${project.title}, ${folderLabel}`;

  if (started) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size="xs"
              className="min-w-0 flex-initial justify-start"
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
        currentFolder={folder}
        defaultFolder={scratchRoot}
        trigger={{
          content,
          ariaLabel: `Change project or folder: ${ariaLabel}`,
          className: "min-w-0 flex-initial justify-start",
        }}
        onSelect={selection.selectProject}
        onEnvironmentChange={onEnvironmentChange}
        onAddProject={selection.openAddProject}
        {...(onComposerFocusRequest ? { onClose: onComposerFocusRequest } : {})}
      />
      {atDefaultPlace || selection.defaultEnvironmentId === null ? null : (
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
