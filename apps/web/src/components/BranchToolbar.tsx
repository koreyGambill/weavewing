import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId, WorktreeProvider } from "@t3tools/contracts";
import { FolderGit2Icon, FolderGitIcon, FolderIcon, PlusIcon, ScaleIcon } from "lucide-react";
import {
  type Ref,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject, useThreadShellsForProjectRefs } from "../state/entities";
import {
  ADD_TO_MACHINE_LABEL_CLASS,
  type EnvMode,
  type EnvironmentOption,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveNewCheckoutOptionLabel,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";
import {
  BranchToolbarEnvironmentBadge,
  BranchToolbarEnvironmentSelector,
  type BranchToolbarEnvironmentSelectorHandle,
} from "./BranchToolbarEnvironmentSelector";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { type AddProjectTarget, useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { useXwingEnvironmentsSupport } from "../state/xwingEnvironments";
import { useAtomValue } from "@effect/atom-react";
import { createDevelopmentEnvironment } from "../state/developmentEnvironmentLifecycle";
import { XwingCheckoutChooser } from "./xwing/XwingCheckoutChooser";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { ComposerControl } from "./chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { cn } from "~/lib/utils";
import { ComposerRow } from "./chat/ComposerRow";
import { COMPOSER_ROW_PRIORITY, type ComposerRowItem } from "./chat/composerRowItems";
import { ComposerRowBranchMenuRow, ComposerRowComputerMenuRow } from "./chat/branchToolbarRowItems";

export interface BranchToolbarHandle {
  openBranchPicker: () => void;
  usePreviousWorktree: () => void;
}

interface BranchToolbarProps {
  layout?: "composer" | "panel";
  panelSection?: "all" | "workspace" | "branch";
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarHandle>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  showGitControls: boolean;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  /** Row items after the diff, such as the thread's agents; see `ComposerRowItem`. */
  rowItems?: ReadonlyArray<ComposerRowItem>;
  /** The project and folder segment, shown after the machine in the composer strip. */
  where?: ReactNode;
  whereProjectTitle?: string | null;
  /** Shown at the end of the composer strip, such as the new thread's permissions. */
  trailing?: ReactNode;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

function showWorkspaceContextMenu(event: ReactMouseEvent, workspacePath: string) {
  const api = readLocalApi();
  if (!api) return;
  event.preventDefault();
  event.stopPropagation();
  void api.contextMenu
    .show([{ id: "copy-path", label: "Copy full path", icon: "copy" }], {
      x: event.clientX,
      y: event.clientY,
    })
    .then((action) => {
      if (action !== "copy-path") return;
      const clipboardPath = formatFilePathForClipboard(workspacePath);
      void writeTextToClipboard(clipboardPath, "workspace path").then(
        undefined,
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to copy path",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    });
}

interface RunContextSelectorProps {
  displayMode?: "toolbar" | "panel";
  workspaceRoot?: string;
  hideLockedWorkspaceLabel?: boolean;
  forceNewWorktree: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
  onUsePreviousWorktree: () => void;
  onNewEnvironment?: (() => void) | undefined;
  selectedWorkspaceLabel?: string | undefined;
  worktreeProvider: WorktreeProvider;
  addTargets: readonly AddProjectTarget[];
  onAddToMachine: (environmentId: EnvironmentId) => void;
}

const RunContextSelector = memo(function RunContextSelector({
  displayMode = "toolbar",
  workspaceRoot,
  hideLockedWorkspaceLabel = false,
  forceNewWorktree,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch,
  onUsePreviousWorktree,
  onNewEnvironment,
  selectedWorkspaceLabel,
  worktreeProvider,
  addTargets,
  onAddToMachine,
}: RunContextSelectorProps) {
  const newCheckoutLabel = resolveNewCheckoutOptionLabel(
    worktreeProvider,
    Boolean(onNewEnvironment),
  );
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel =
    selectedWorkspaceLabel ??
    (forceNewWorktree
      ? resolveEnvModeLabel("worktree", worktreeProvider)
      : envModeLocked
        ? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, worktreeProvider)
        : effectiveEnvMode === "worktree"
          ? resolveEnvModeLabel("worktree", worktreeProvider)
          : resolveCurrentWorkspaceLabel(activeWorktreePath));
  const isPanel = displayMode === "panel";
  const isLocked = envLocked || (envModeLocked && (!isPanel || !showEnvironmentPicker));
  const workspacePath =
    selectedWorkspaceLabel ||
    forceNewWorktree ||
    (effectiveEnvMode === "worktree" && !activeWorktreePath)
      ? null
      : (activeWorktreePath ?? workspaceRoot);
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (isPanel && workspacePath) {
      showWorkspaceContextMenu(event, workspacePath);
    }
  };
  const workspaceIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <WorkspaceIcon className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"} />
      </TooltipTrigger>
      <TooltipPopup>
        {isPanel || hideLockedWorkspaceLabel
          ? forceNewWorktree
            ? "Each model starts in its own worktree."
            : (workspacePath ?? workspaceLabel)
          : workspaceLabel}
      </TooltipPopup>
    </Tooltip>
  );
  const environmentIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        {autoEnvironmentLabel ? (
          <ScaleIcon
            className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
            aria-hidden="true"
          />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            // Wide machine glyphs need a little more box to match the square row icons.
            className={
              isPanel ? cn(THREAD_DETAILS_PANEL_ICON_CLASS, "-mx-px size-4.5") : "size-3 shrink-0"
            }
          />
        )}
      </TooltipTrigger>
      <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
    </Tooltip>
  );
  const icon = showEnvironmentIndicator ? environmentIcon : workspaceIcon;
  const triggerContent = (
    <>
      {icon}
      {autoEnvironmentLabel || showEnvironmentIndicator || !hideLockedWorkspaceLabel ? (
        <ComposerContextLabel displayMode={displayMode}>
          {autoEnvironmentLabel ??
            (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel)}
        </ComposerContextLabel>
      ) : null}
      {showEnvironmentIndicator && !autoEnvironmentLabel ? (
        <BranchToolbarEnvironmentBadge environment={activeEnvironment} />
      ) : null}
      {/* Trailing in the panel, so every row label starts on the same edge. */}
      {isPanel && showEnvironmentIndicator ? workspaceIcon : null}
    </>
  );

  if (isLocked) {
    return (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-[48%] flex-initial items-center justify-start gap-1 rounded-md border border-transparent px-1.75 font-normal text-foreground/70 text-sm sm:h-6 sm:text-xs dark:text-muted-foreground",
          isPanel && "max-w-full",
          isPanel ? THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS : "[&_svg]:text-foreground/70",
        )}
        onContextMenu={handleContextMenu}
        aria-label={
          isPanel
            ? `Run context: ${[autoEnvironmentLabel ?? activeEnvironment?.label, workspaceLabel].filter(Boolean).join(", ")}`
            : undefined
        }
        data-composer-context-control
      >
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={isPanel ? <ThreadDetailsControl part="select" /> : <ComposerControl size="xs" />}
        className={isPanel ? undefined : "min-w-0 max-w-[48%] flex-initial justify-start"}
        onContextMenu={handleContextMenu}
        onMouseDownCapture={
          isPanel
            ? (event) => {
                if (event.button !== 0 || event.ctrlKey) event.stopPropagation();
              }
            : undefined
        }
        aria-label={
          isPanel
            ? `Run context: ${[autoEnvironmentLabel ?? activeEnvironment?.label, workspaceLabel].filter(Boolean).join(", ")}`
            : undefined
        }
        data-composer-context-control
        data-composer-shortcut={[
          showEnvironmentPicker && !envLocked ? "composer.host" : "",
          !envModeLocked ? "composer.workspace" : "",
        ].join(" ")}
      >
        {triggerContent}
      </MenuTrigger>
      <MenuPopup
        align="start"
        side={isPanel ? "bottom" : "top"}
        className={
          isPanel
            ? "w-(--anchor-width)"
            : previousWorktreeLabel
              ? "w-[min(21rem,calc(100vw-2rem))]"
              : undefined
        }
        {...(!isPanel ? composerFloatingLayerProps : {})}
      >
        {availableEnvironments &&
        ((showEnvironmentPicker && onEnvironmentChange) || addTargets.length > 0) ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={autoEnvironmentLabel ? "auto" : environmentId}
                onValueChange={(value) =>
                  value === "auto"
                    ? onAutoEnvironment?.()
                    : onEnvironmentChange?.(value as EnvironmentId)
                }
              >
                {onAutoEnvironment && (
                  <MenuRadioItem
                    value="auto"
                    disabled={envLocked}
                    closeOnClick
                    onClick={() => {
                      if (autoEnvironmentLabel) onAutoEnvironment?.();
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ScaleIcon className="size-3" aria-hidden="true" />
                      <span className="min-w-0 truncate">
                        {autoEnvironmentLabel ?? "Auto balance"}
                      </span>
                    </span>
                  </MenuRadioItem>
                )}
                {availableEnvironments.map((env) => (
                  <MenuRadioItem
                    key={env.environmentId}
                    disabled={
                      envLocked || (!onEnvironmentChange && env.environmentId !== environmentId)
                    }
                    value={env.environmentId}
                    closeOnClick
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                      <span className="min-w-0 truncate">{env.label}</span>
                      <BranchToolbarEnvironmentBadge environment={env} />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {addTargets.length > 0 ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                      <PlusIcon className="size-3" />
                      <span className="min-w-0 truncate">Add to another machine</span>
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup {...(!isPanel ? composerFloatingLayerProps : {})}>
                    {addTargets.map((target) => (
                      <MenuItem
                        key={target.environmentId}
                        onClick={() => onAddToMachine(target.environmentId)}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                          <span className="min-w-0 truncate">{target.label}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={selectedWorkspaceLabel ? "xwing-environment" : effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "new-environment") {
                onNewEnvironment?.();
                return;
              }
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked || forceNewWorktree} value="local" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <MiddleTruncate value={resolveCurrentWorkspaceLabel(activeWorktreePath)} />
              </span>
            </MenuRadioItem>
            {onNewEnvironment ? (
              <MenuRadioItem disabled={envModeLocked} value="new-environment" closeOnClick>
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGit2Icon className="size-3" /> New environment
                </span>
              </MenuRadioItem>
            ) : null}
            {newCheckoutLabel !== null ? (
              <MenuRadioItem disabled={envModeLocked} value="worktree" closeOnClick>
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  <span className="min-w-0 truncate">{newCheckoutLabel}</span>
                </span>
              </MenuRadioItem>
            ) : null}
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree" closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

export const BranchToolbar = memo(function BranchToolbar({
  layout = "composer",
  panelSection = "all",
  forceNewWorktree = false,
  ref,
  environmentId,
  threadId,
  projectId,
  worktreePath,
  isServerThread,
  showGitControls,
  draftId,
  onEnvModeChange,
  envMode,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  rowItems,
  where,
  whereProjectTitle,
  trailing,
}: BranchToolbarProps) {
  const branchSelectorRef = useRef<BranchToolbarBranchSelectorHandle>(null);
  const environmentSelectorRef = useRef<BranchToolbarEnvironmentSelectorHandle>(null);
  const [createEnvironmentOpen, setCreateEnvironmentOpen] = useState(false);
  const supportsXwing = useXwingEnvironmentsSupport(environmentId);
  const worktreeProvider = useEnvironmentSettings(
    environmentId,
    (settings) => settings.worktreeProvider,
  );
  const canCreateEnvironment = useAtomValue(
    createDevelopmentEnvironment.permissionAtom(environmentId),
  );
  const threadRef = scopeThreadRef(environmentId, threadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftXwingEnvironment = useComposerDraftStore(
    (store) =>
      (draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef))
        ?.xwingEnvironment,
  );
  // The composer retains resolved thread details while bootstrap cleanup can remove its shell.
  const activeProjectRef = scopeProjectRef(environmentId, projectId);
  const activeProject = useProject(activeProjectRef);
  const activeWorktreePath = forceNewWorktree ? null : worktreePath;
  const effectiveEnvMode = forceNewWorktree ? "worktree" : envMode;
  const envModeLocked = envLocked || (isServerThread && activeWorktreePath !== null);
  const onNewEnvironment =
    supportsXwing && canCreateEnvironment && !forceNewWorktree && !envModeLocked
      ? () => setCreateEnvironmentOpen(true)
      : undefined;

  const canUsePreviousWorktree = !isServerThread && !envModeLocked && !forceNewWorktree;
  const projectRefsForWorktreeLookup = canUsePreviousWorktree ? [activeProjectRef] : [];
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = canUsePreviousWorktree
    ? resolvePreviousWorktreeSeed({
        threads: projectThreads,
        currentWorktreePath: activeWorktreePath,
      })
    : null;
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = () => {
    if (!previousWorktreeSeed) return;
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  };

  // A started thread may move between checkouts while stopped; the server decides when.
  const showXwingChooser = !forceNewWorktree && (isServerThread || !envModeLocked);

  useImperativeHandle(
    ref,
    () => ({
      openBranchPicker: () => branchSelectorRef.current?.open(),
      usePreviousWorktree: () => {
        if (!showGitControls || !canUsePreviousWorktree || !previousWorktreeSeed) return;
        onUsePreviousWorktree();
        onComposerFocusRequest?.();
      },
    }),
    [
      canUsePreviousWorktree,
      onComposerFocusRequest,
      onUsePreviousWorktree,
      previousWorktreeSeed,
      showGitControls,
    ],
  );

  const addTargets = useAddProjectTargets(activeProject, availableEnvironments);
  const onAddToMachine = (targetEnvironmentId: EnvironmentId | null) =>
    openAddProjectToMachine({ projectRef: activeProjectRef, targetEnvironmentId });
  // A project on one machine still gets the picker when it can be added to another.
  const hasMultipleEnvironments = (availableEnvironments?.length ?? 0) > 1 || addTargets.length > 0;
  const showEnvironmentPicker = hasMultipleEnvironments && onEnvironmentChange !== undefined;
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  // Started threads get no handler but still show which machine they run on,
  // matching the strip visibility ChatView computes from the same inputs.
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });
  // A locked thread in the project's own checkout is the default, so naming it adds only noise.
  const showWorkspaceMode =
    showGitControls &&
    !(envModeLocked && !forceNewWorktree && !activeWorktreePath && effectiveEnvMode === "local");
  if (!activeProject) return null;

  if (layout === "panel") {
    return (
      <div className="flex w-full flex-col" data-thread-panel-run-context>
        {showGitControls && showXwingChooser && panelSection !== "branch" ? (
          <XwingCheckoutChooser
            showLabel
            environmentId={environmentId}
            threadId={threadId}
            draftId={draftId}
            projectId={projectId}
            createOpen={createEnvironmentOpen}
            onCreateOpenChange={setCreateEnvironmentOpen}
          />
        ) : null}
        {panelSection !== "branch" ? (
          <RunContextSelector
            displayMode="panel"
            workspaceRoot={activeProject.workspaceRoot}
            forceNewWorktree={forceNewWorktree}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            envModeLocked={envModeLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            showEnvironmentIndicator={activeEnvironmentOption !== null}
            onEnvironmentChange={onEnvironmentChange}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={previousWorktreeLabel}
            previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
            onUsePreviousWorktree={onUsePreviousWorktree}
            onNewEnvironment={onNewEnvironment}
            selectedWorkspaceLabel={!isServerThread ? draftXwingEnvironment?.label : undefined}
            worktreeProvider={worktreeProvider}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        ) : null}
        {panelSection !== "workspace" ? (
          <BranchToolbarBranchSelector
            displayMode="panel"
            className="w-full"
            environmentId={environmentId}
            threadId={threadId}
            {...(draftId ? { draftId } : {})}
            envLocked={envLocked}
            effectiveEnvModeOverride={effectiveEnvMode}
            {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
            {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
            startFromOrigin={startFromOrigin}
            onStartFromOriginChange={onStartFromOriginChange}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        ) : null}
      </div>
    );
  }

  const hideLockedWorkspaceLabel =
    where != null &&
    envModeLocked &&
    activeWorktreePath !== null &&
    (isServerThread || !draftXwingEnvironment?.label) &&
    resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, worktreeProvider) ===
      whereProjectTitle;

  const canOpenEnvironmentSelector = !envLocked && (showEnvironmentPicker || addTargets.length > 0);
  const items: ReadonlyArray<ComposerRowItem> = [
    {
      id: "computer",
      priority: COMPOSER_ROW_PRIORITY.computer,
      hidden: !availableEnvironments || !showEnvironmentIndicator,
      renderRowItem: () =>
        availableEnvironments ? (
          <BranchToolbarEnvironmentSelector
            ref={environmentSelectorRef}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            {...(showEnvironmentPicker ? { onEnvironmentChange } : {})}
            {...(addTargets.length > 0 ? { onAddToMachine: () => onAddToMachine(null) } : {})}
          />
        ) : null,
      ...(canOpenEnvironmentSelector
        ? { openPopup: () => environmentSelectorRef.current?.open() }
        : {}),
      renderMenuRow: ({ openPopover }) => (
        <ComposerRowComputerMenuRow
          environment={activeEnvironmentOption}
          label={autoEnvironmentLabel ?? activeEnvironmentOption?.label ?? "Run on"}
          onOpen={
            canOpenEnvironmentSelector
              ? () => openPopover(() => environmentSelectorRef.current?.open())
              : undefined
          }
        />
      ),
    },
    {
      id: "location",
      priority: null,
      shrinks: true,
      renderRowItem: () => (
        <>
          {showWorkspaceMode ? (
            <BranchToolbarEnvModeSelector
              hideLockedWorkspaceLabel={hideLockedWorkspaceLabel}
              forceNewWorktree={forceNewWorktree}
              envLocked={envModeLocked}
              effectiveEnvMode={effectiveEnvMode}
              activeWorktreePath={activeWorktreePath}
              onEnvModeChange={onEnvModeChange}
              previousWorktreeLabel={previousWorktreeLabel}
              previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
              onUsePreviousWorktree={onUsePreviousWorktree}
              onNewEnvironment={onNewEnvironment}
              selectedWorkspaceLabel={!isServerThread ? draftXwingEnvironment?.label : undefined}
              worktreeProvider={worktreeProvider}
            />
          ) : null}
          {where}
          {showGitControls && showXwingChooser ? (
            <XwingCheckoutChooser
              environmentId={environmentId}
              threadId={threadId}
              draftId={draftId}
              projectId={projectId}
              createOpen={createEnvironmentOpen}
              onCreateOpenChange={setCreateEnvironmentOpen}
            />
          ) : null}
        </>
      ),
    },
    {
      id: "branch",
      priority: COMPOSER_ROW_PRIORITY.branch,
      shrinks: true,
      hidden: !showGitControls,
      renderRowItem: () => (
        <BranchToolbarBranchSelector
          forceNewWorktree={forceNewWorktree}
          ref={branchSelectorRef}
          className="min-w-0 flex-initial"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          effectiveEnvModeOverride={effectiveEnvMode}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ),
      renderMenuRow: ({ openPopover, setValueElement }) => (
        <ComposerRowBranchMenuRow
          setValueElement={setValueElement}
          onOpen={() => openPopover(() => branchSelectorRef.current?.open())}
        />
      ),
    },
    { id: "diff", priority: null, renderRowItem: () => trailing },
    ...(rowItems ?? []),
  ];
  return <ComposerRow items={items} />;
});
