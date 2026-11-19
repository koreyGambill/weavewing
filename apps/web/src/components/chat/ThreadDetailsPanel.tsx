import { ThreadListSummary } from "../reviews/ThreadListView";
import { Popover, PopoverPopup } from "../ui/popover";
import { ThreadDetailsLocation } from "./ThreadDetailsDestination";
import { openChangeThreadFolder } from "./changeThreadFolderDialogState";
import { useAtomValue } from "@effect/atom-react";
import { changeThreadFolder } from "../../state/xwingEnvironments";
import { FolderIcon } from "lucide-react";
import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import type { ComposerThreadTarget, DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { memo, useState, type ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";
import {
  ThreadDetailsContext,
  ThreadDetailsUsage,
  type ThreadDetailsUsageInput,
} from "./ThreadDetailsUsage";
import { ThreadDetailsItemsMenuItems } from "./ThreadDetailsItemsMenu";
import { resolveThreadDetailsVisibility, THREAD_DETAILS_ITEMS } from "./threadDetailsItems";
import { useClientSettings } from "../../hooks/useSettings";
import { useProject, useServerConfigs } from "../../state/entities";
import { ThreadDetailsThreadPrRows } from "./ThreadDetailsPrRows";
import { cn } from "../../lib/utils";
import { SlidersHorizontalIcon } from "lucide-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";
import { Menu, MenuPopup } from "../ui/menu";

const GitActionsControl = memo(BaseGitActionsControl);

interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  composerDraftTarget: ComposerThreadTarget;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  workspaceMutationId: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  usage: ThreadDetailsUsageInput;
  actionsHandle?: ThreadDetailsPanelProps["handle"];
  lineageHandle?: ThreadDetailsPanelProps["handle"];
  composerContextAvailable?: boolean;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const visible = useClientSettings(resolveThreadDetailsVisibility);
  const canChangeFolder = useAtomValue(changeThreadFolder.permissionAtom(props.environmentId));
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const threadKey = `${props.environmentId}:${props.threadId}`;
  const [flyout, setFlyout] = useState<{ threadKey: string; kind: "actions" | "lineage" } | null>(
    null,
  );
  const flyoutKind = flyout?.threadKey === threadKey ? flyout.kind : null;
  const onFlyoutChange = (kind: "actions" | "lineage", open: boolean) => {
    setFlyout((current) => (open ? { threadKey, kind } : current?.kind === kind ? null : current));
  };
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts && (visible.scripts || flyoutKind === "actions")
      ? props.gitCwd
      : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const serverConfig = useServerConfigs().get(props.environmentId);
  // A No project thread's folder sits inside the shared scratch root, so it must never get git.
  // Until the config and project load, a No project thread looks like any other folder.
  const offersGit =
    props.gitCwd !== null &&
    serverConfig !== undefined &&
    project !== null &&
    !isScratchProject(project, serverConfig.scratchWorkspaceRoot);
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  const renderItems = (density: "full" | "compact" | "essential", surface: "card" | "actions") => {
    const card = surface === "card";
    const actions = !card || flyoutKind !== "actions";
    const workspaceFallback = !props.composerContextAvailable && Boolean(props.actionsHandle);
    const showCheckout = card
      ? !(workspaceFallback && flyoutKind === "actions")
      : workspaceFallback;
    const show = {
      environment:
        showCheckout && (card ? density === "full" && visible.environment : workspaceFallback),
      openIn:
        actions && (!card || (density !== "essential" && visible.openIn)) && props.showOpenInPicker,
      scripts: actions && (!card || visible.scripts) && props.activeProjectScripts !== undefined,
      branch:
        showCheckout && (card ? visible.branch : workspaceFallback) && offersGit && props.isGitRepo,
      pullRequests: actions && (!card || visible.branch) && !(offersGit && props.isGitRepo),
      git:
        actions &&
        offersGit &&
        props.activeProjectName !== undefined &&
        (!card || visible.gitActions || (visible.changes && props.isGitRepo)),
    };
    return (
      <>
        <div className="group/details-items">
          {card ? <ThreadListSummary threadRef={activeThreadRef} /> : null}
          {show.environment || show.openIn || show.scripts ? (
            <ThreadDetailsSection
              headingId={`thread-details-workspace-${surface}-heading`}
              title="Workspace"
              separated={false}
              showHeading={false}
            >
              <div className="flex flex-col">
                {show.environment ? (
                  <BranchToolbar
                    layout="panel"
                    panelSection="workspace"
                    availableEnvironments={props.availableEnvironments}
                    {...(props.onEnvironmentChange
                      ? { onEnvironmentChange: props.onEnvironmentChange }
                      : {})}
                    autoEnvironmentLabel={props.autoEnvironmentLabel}
                    onAutoEnvironment={props.onAutoEnvironment}
                    {...branchToolbarProps}
                  />
                ) : null}

                {show.openIn ? (
                  <OpenInPicker
                    keybindings={props.keybindings}
                    environmentId={props.environmentId}
                    availableEditors={props.availableEditors}
                    openInCwd={props.gitCwd}
                    enableShortcut={props.openInShortcutEnabled}
                    displayMode="panel"
                  />
                ) : null}

                {show.scripts && props.activeProjectScripts ? (
                  <ProjectScriptsControl
                    environmentId={props.environmentId}
                    displayMode="panel"
                    scripts={props.activeProjectScripts}
                    fileScripts={fileScripts}
                    preferredScriptId={props.preferredScriptId}
                    onRunScript={props.onRunProjectScript}
                    onAddScript={props.onAddProjectScript}
                    onUpdateScript={props.onUpdateProjectScript}
                    onDeleteScript={props.onDeleteProjectScript}
                  />
                ) : null}
              </div>
            </ThreadDetailsSection>
          ) : null}

          {show.branch || show.pullRequests || show.git ? (
            <ThreadDetailsSection
              headingId={`thread-details-version-control-${surface}-heading`}
              title="Version Control"
              showHeading={false}
              separated={density === "full"}
            >
              <div className="flex flex-col">
                {show.branch ? (
                  <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                ) : null}
                {show.pullRequests ? (
                  <ThreadDetailsThreadPrRows
                    threadRef={activeThreadRef}
                    project={project}
                    composerTarget={props.composerDraftTarget}
                  />
                ) : null}
                {show.git && props.gitCwd ? (
                  <GitActionsControl
                    compact={density !== "full"}
                    showActions={!card || visible.gitActions}
                    showChanges={card ? visible.changes : !props.isServerThread}
                    gitCwd={props.gitCwd}
                    workspaceMutationId={props.workspaceMutationId}
                    activeThreadRef={activeThreadRef}
                    {...(props.draftId ? { draftId: props.draftId } : {})}
                    {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                  />
                ) : null}
              </div>
            </ThreadDetailsSection>
          ) : null}

          {!props.draftId && (card || workspaceFallback) && showCheckout ? (
            <ThreadDetailsSection
              headingId={`thread-details-folder-${surface}-heading`}
              title="Folder"
              showHeading={false}
            >
              <ThreadDetailsControl
                disabled={!canChangeFolder}
                onClick={() => openChangeThreadFolder(activeThreadRef)}
              >
                <FolderIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                Change folder…
              </ThreadDetailsControl>
            </ThreadDetailsSection>
          ) : null}
          {actions && density === "full" && !props.draftId && (!card || visible.servers) ? (
            <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {actions && density === "full" && !props.draftId && (!card || visible.automations) ? (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {card &&
          flyoutKind !== "lineage" &&
          density === "full" &&
          !props.draftId &&
          (visible.lineage || visible.sideChats) ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
              showLineage={visible.lineage}
              showSideChats={visible.sideChats}
            />
          ) : null}

          {visible.usage && actions ? <ThreadDetailsUsage {...props.usage} /> : null}

          {(card
            ? visible.context && !(workspaceFallback && flyoutKind === "actions")
            : workspaceFallback) && props.usage.contextWindow ? (
            <ThreadDetailsContext usage={props.usage.contextWindow} />
          ) : null}

          {card ? (
            <div className="p-2 group-has-[>section>:last-child:not(:empty)]/details-items:hidden">
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="row"
                panel
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenuPosition({ x: rect.left, y: rect.bottom });
                }}
              >
                <SlidersHorizontalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                  Choose what to show
                </span>
              </ThreadDetailsControl>
            </div>
          ) : null}
        </div>

        {card ? (
          <Menu
            open={menuPosition !== null}
            onOpenChange={(open) => !open && setMenuPosition(null)}
          >
            <MenuPopup
              anchor={
                menuPosition
                  ? {
                      getBoundingClientRect: () =>
                        new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                    }
                  : undefined
              }
              align="start"
              side="bottom"
            >
              <ThreadDetailsItemsMenuItems />
            </MenuPopup>
          </Menu>
        ) : null}
      </>
    );
  };

  return (
    <>
      <ThreadDetailsLocation
        threadRef={activeThreadRef}
        anchor={props.anchor}
        handle={props.handle}
        contentKey={THREAD_DETAILS_ITEMS.filter((item) => visible[item.id])
          .map((item) => item.id)
          .join(",")}
        onContextMenu={(event) => {
          // Popups the card opens bubble here through React; they, fields, links, and selected text
          // keep their own menus.
          const target = event.target;
          const selection = window.getSelection();
          if (
            !(target instanceof Element) ||
            !event.currentTarget.contains(target) ||
            target.closest("input, textarea, [contenteditable], a[href]") ||
            (selection &&
              !selection.isCollapsed &&
              (event.currentTarget.contains(selection.anchorNode) ||
                event.currentTarget.contains(selection.focusNode)))
          )
            return;
          event.preventDefault();
          setMenuPosition({ x: event.clientX, y: event.clientY });
        }}
      >
        {(density) => renderItems(density, "card")}
      </ThreadDetailsLocation>
      {props.actionsHandle ? (
        <Popover
          handle={props.actionsHandle}
          open={flyoutKind === "actions"}
          onOpenChange={(open) => onFlyoutChange("actions", open)}
        >
          <PopoverPopup aria-label="Workspace actions" width="md" padding="none" align="end">
            {flyoutKind === "actions" ? renderItems("full", "actions") : null}
          </PopoverPopup>
        </Popover>
      ) : null}
      {props.lineageHandle ? (
        <Popover
          handle={props.lineageHandle}
          open={flyoutKind === "lineage"}
          onOpenChange={(open) => onFlyoutChange("lineage", open)}
        >
          <PopoverPopup aria-label="Thread lineage" width="md" padding="none" align="end">
            {flyoutKind === "lineage" ? (
              <ThreadRelationshipsPanel
                environmentId={props.environmentId}
                threadId={props.threadId}
                showLineage
                showSideChats
                empty={
                  <p className="px-3 py-2 text-xs text-muted-foreground">No related threads yet.</p>
                }
              />
            ) : null}
          </PopoverPopup>
        </Popover>
      ) : null}
    </>
  );
}
