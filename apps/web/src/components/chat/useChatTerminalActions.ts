import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { Dispatch } from "react";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { selectThreadTerminalUiState } from "../../terminalUiStateStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectScript,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import { type SetStateAction } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MAX_TERMINALS_PER_GROUP } from "../../types";
import {
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { confirmTerminalClose } from "../../lib/terminalCloseConfirm";
import { findReusableProjectScriptTerminal } from "../../lib/projectScriptTerminal";
import { closingTerminalIds } from "../terminal/closingTerminals";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import {
  focusActiveDrawerTerminal,
  focusActivePanelTerminal,
  focusTerminal,
} from "../../lib/terminalFocus";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  makeThreadErrorSetter,
} from "../ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { previewEnvironment } from "../../state/preview";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatShortcutCommands } from "./useChatShortcuts";
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
  /** The thread's checkout when this was set; once the thread moves, the context is stale. */
  threadWorktreePath: string | null;
}

interface ChatTerminalActionsInput {
  readonly tiled?: boolean;
  readonly environmentId: EnvironmentId;
  readonly composerRef: ComposerHandleRef;
  readonly terminalUiState: ReturnType<typeof selectThreadTerminalUiState>;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly activeServerOrderedTerminalIds: ReadonlyArray<string>;
  readonly activeTerminalLabelsById: ReadonlyMap<string, string>;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly canReuseTerminal: boolean;
  readonly gitCwd: string | null;
  readonly setTerminalUiLaunchContext: Dispatch<SetStateAction<TerminalLaunchContext | null>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Routes terminal controls and script execution to the thread's terminal surfaces.
 */
export function useChatTerminalActions(input: ChatTerminalActionsInput) {
  const {
    tiled = false,
    environmentId,
    composerRef,
    terminalUiState,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    panelTerminalIds,
    canReuseTerminal,
    gitCwd,
    setTerminalUiLaunchContext,
    setThreadError,
  } = input;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const hasTerminalWriteAccess = () =>
    readEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const terminalActions = useThreadTerminalActions(activeThreadRef);

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const addTerminalContextToDraft = (selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  };
  const addTerminalContextToDraftStable = useStableCallback(addTerminalContextToDraft);
  const revealTiledTerminal = (terminalId: string) => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    const surface = selectThreadRightPanelState(store.byThreadKey, activeThreadRef).surfaces.find(
      (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
    );
    if (surface) {
      store.activateSurface(activeThreadRef, surface.id);
      store.activateTerminal(activeThreadRef, surface.id, terminalId);
    } else {
      store.openTerminal(activeThreadRef, terminalId);
    }
    focusTerminal(activeThreadRef, terminalId);
  };
  const revealOrCreateTiledTerminal = () => {
    if (!activeThreadRef) return;
    const { surfaces, activeSurfaceId } = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    const surface =
      surfaces.find((entry) => entry.id === activeSurfaceId && entry.kind === "terminal") ??
      surfaces.find((entry) => entry.kind === "terminal");
    const terminalId =
      surface?.kind === "terminal"
        ? surface.activeTerminalId
        : (terminalUiState.terminalIds.find((id) => id === terminalUiState.activeTerminalId) ??
          terminalUiState.terminalIds[0] ??
          runningTerminalIds[0] ??
          activeServerOrderedTerminalIds[0]);
    if (terminalId !== undefined) {
      revealTiledTerminal(terminalId);
      return;
    }
    const launched = terminalActions.launchTerminal({ place: revealTiledTerminal });
    if (launched) void launched.result;
  };
  const setTerminalOpen = (open: boolean) => {
    if (!activeThreadRef) return;
    if (tiled) {
      if (open) revealOrCreateTiledTerminal();
      return;
    }
    storeSetTerminalOpen(activeThreadRef, open);
    focusActiveDrawerTerminal(activeThreadRef);
  };
  const setTerminalOpenStable = useStableCallback(setTerminalOpen);
  const toggleTerminalVisibility = () => {
    if (!activeThreadRef) return;
    if (tiled) {
      if (readEnvironmentScope(environmentId, AuthTerminalReadScope) || hasTerminalWriteAccess()) {
        revealOrCreateTiledTerminal();
      }
      return;
    }
    const nextOpen = !terminalUiState.terminalOpen;
    if (
      nextOpen &&
      !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
      !hasTerminalWriteAccess()
    )
      return;
    if (nextOpen && hasTerminalWriteAccess() && terminalUiState.terminalIds.length === 0) {
      // Server-created setup terminals exist before this client's drawer mounts.
      // Reuse them before allocating a shell from the still-empty UI state.
      // The server lists a closing terminal until its close finishes, which would end the reopen.
      const closingIds = new Set(closingTerminalIds(activeThreadRef));
      const isReusable = (id: string) => !panelTerminalIds.has(id) && !closingIds.has(id);
      const existingTerminalId =
        runningTerminalIds.find(isReusable) ?? activeServerOrderedTerminalIds.find(isReusable);
      if (existingTerminalId !== undefined) {
        storeEnsureTerminal(activeThreadRef, existingTerminalId, { open: true, active: true });
        focusActiveDrawerTerminal(activeThreadRef);
        return;
      }
      void terminalActions.launchTerminal({
        place: (terminalId) => storeEnsureTerminal(activeThreadRef, terminalId, { open: true }),
      })?.result;
      focusActiveDrawerTerminal(activeThreadRef);
      return;
    }
    setTerminalOpen(nextOpen);
  };
  const toggleTerminalVisibilityStable = useStableCallback(toggleTerminalVisibility);
  const addTerminalSurface = () => {
    if (!activeThreadRef) return;
    const location =
      activeRightPanelSurface?.kind === "terminal"
        ? activeRightPanelSurface.launchContext
        : undefined;
    const launched = terminalActions.launchTerminal({
      ...(location ? { location } : {}),
      place: (terminalId) =>
        useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId, location),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const addTerminalSurfaceStable = useStableCallback(addTerminalSurface);
  const splitPanelTerminalForSurface = (
    surfaceId: string,
    direction: "horizontal" | "vertical" = "horizontal",
  ) => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    const surface = selectThreadRightPanelState(store.byThreadKey, activeThreadRef).surfaces.find(
      (entry) => entry.id === surfaceId,
    );
    if (surface?.kind !== "terminal" || surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP)
      return;
    const launched = terminalActions.launchTerminal({
      ...(surface.launchContext ? { location: surface.launchContext } : {}),
      place: (terminalId) =>
        useRightPanelStore
          .getState()
          .splitTerminal(activeThreadRef, surfaceId, terminalId, direction),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const splitPanelTerminalForSurfaceStable = useStableCallback(splitPanelTerminalForSurface);
  const splitTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (tiled) {
      if (activeRightPanelSurface?.kind === "terminal") {
        splitPanelTerminalForSurface(activeRightPanelSurface.id, direction);
      } else {
        addTerminalSurface();
      }
      return;
    }
    if (!activeThreadRef || hasReachedSplitLimit) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        direction === "vertical"
          ? storeSplitTerminalVertical(activeThreadRef, terminalId)
          : storeSplitTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const splitTerminalStable = useStableCallback(splitTerminal);
  const createNewTerminal = () => {
    if (!activeThreadRef) return;
    if (tiled) {
      addTerminalSurface();
      return;
    }
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => storeNewTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const createNewTerminalStable = useStableCallback(createNewTerminal);
  const runProjectScript = async (
    script: ProjectScript,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      worktreePath?: string | null;
      preferNewTerminal?: boolean;
      rememberAsLastInvoked?: boolean;
      shellHistory?: "preserve" | "suppress";
    },
  ) => {
    if (!hasTerminalWriteAccess() || !activeThreadId || !activeProject || !activeThread) return;
    if (options?.rememberAsLastInvoked !== false) {
      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });
    }
    const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
    const reusableTerminalId =
      script.stopOnSettle ||
      options?.preferNewTerminal ||
      !canReuseTerminal ||
      !readEnvironmentScope(environmentId, AuthTerminalReadScope)
        ? null
        : findReusableProjectScriptTerminal({
            drawerTerminalIds: [
              ...new Set([
                ...terminalUiState.terminalIds,
                ...activeServerOrderedTerminalIds,
                ...(tiled ? panelTerminalIds : []),
              ]),
            ],
            activeTerminalId:
              tiled && activeRightPanelSurface?.kind === "terminal"
                ? activeRightPanelSurface.activeTerminalId
                : terminalUiState.activeTerminalId,
            panelTerminalIds: tiled ? new Set<string>() : panelTerminalIds,
            runningTerminalIds,
            closingTerminalIds: activeThreadRef ? closingTerminalIds(activeThreadRef) : [],
          });
    const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

    setTerminalUiLaunchContext({
      threadId: activeThreadId,
      cwd: targetCwd,
      worktreePath: targetWorktreePath,
      threadWorktreePath: activeThread.worktreePath ?? null,
    });
    if (!activeThreadRef) {
      return;
    }

    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        tiled
          ? revealTiledTerminal(terminalId)
          : reusableTerminalId === null
            ? storeNewTerminal(activeThreadRef, terminalId)
            : storeEnsureTerminal(activeThreadRef, terminalId, { open: true }),
      ...(reusableTerminalId === null
        ? { size: { cols: SCRIPT_TERMINAL_COLS, rows: SCRIPT_TERMINAL_ROWS } }
        : { terminalId: reusableTerminalId }),
      location: { cwd: targetCwd, worktreePath: targetWorktreePath },
      stopOnSettle: script.stopOnSettle ?? false,
      ...(options?.env ? { extraEnv: options.env } : {}),
    });
    if (!launched) return;
    const targetTerminalId = launched.terminalId;
    focusTerminal(activeThreadRef, targetTerminalId);
    const openResult = await launched.result;
    if (openResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(openResult)) {
        const error = squashAtomCommandFailure(openResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }

    const writeResult = await terminalActions.writeToTerminal(
      targetTerminalId,
      options?.shellHistory === "preserve"
        ? `${script.command}\r`
        : projectScriptTerminalInput(script.command),
    );
    if (!writeResult) return;
    if (writeResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }
    if (
      script.autoOpenPreview &&
      script.previewUrl &&
      isPreviewAvailableFor(activeThreadRef.environmentId)
    ) {
      const previewResult = await openUrlInPreview({
        threadRef: activeThreadRef,
        url: resolveDiscoveredServerUrl(activeThreadRef.environmentId, script.previewUrl),
        openPreview,
      });
      if (previewResult._tag === "Failure" && !isAtomCommandInterrupted(previewResult)) {
        const error = squashAtomCommandFailure(previewResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open preview",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
    }
  };
  const runProjectScriptStable = useStableCallback(runProjectScript);

  const runShellCommand = (command: string) => {
    void runProjectScript(
      {
        id: "chat-code-block",
        name: "Chat code block",
        command,
        icon: "play",
        runOnWorktreeCreate: false,
      },
      { rememberAsLastInvoked: false, shellHistory: "preserve" },
    );
  };
  const runShellCommandStable = useStableCallback(runShellCommand);
  const splitPanelTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (activeRightPanelSurface?.kind !== "terminal") return;
    splitPanelTerminalForSurface(activeRightPanelSurface.id, direction);
  };
  const splitPanelTerminalStable = useStableCallback(splitPanelTerminal);
  const splitPanelTerminalVertical = () => {
    splitPanelTerminal("vertical");
  };
  const splitPanelTerminalVerticalStable = useStableCallback(splitPanelTerminalVertical);
  const activatePanelTerminalForSurface = (surfaceId: string, terminalId: string) => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    const surface = selectThreadRightPanelState(store.byThreadKey, activeThreadRef).surfaces.find(
      (entry) => entry.id === surfaceId,
    );
    if (surface?.kind !== "terminal" || !surface.terminalIds.includes(terminalId)) return;
    store.activateSurface(activeThreadRef, surfaceId);
    store.activateTerminal(activeThreadRef, surfaceId, terminalId);
    focusTerminal(activeThreadRef, terminalId);
  };
  const activatePanelTerminalForSurfaceStable = useStableCallback(activatePanelTerminalForSurface);
  const activatePanelTerminal = (terminalId: string) => {
    if (activeRightPanelSurface?.kind !== "terminal") return;
    activatePanelTerminalForSurface(activeRightPanelSurface.id, terminalId);
  };
  const activatePanelTerminalStable = useStableCallback(activatePanelTerminal);
  const closePanelTerminal = (terminalId: string, target = activeThreadRef) => {
    if (!target || !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)) return;
    const store = useRightPanelStore.getState();
    const surface = selectThreadRightPanelState(store.byThreadKey, target).surfaces.find(
      (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
    );
    if (!surface) return;
    terminalActions.closeTerminalSession(terminalId, target);
    storeCloseTerminal(target, terminalId);
    store.closeTerminal(target, surface.id, terminalId);
    focusActivePanelTerminal(target);
  };
  const closePanelTerminalStable = useStableCallback(closePanelTerminal);
  const closeTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess() || !activeThreadRef) return;
    if (tiled) {
      closePanelTerminal(terminalId);
      return;
    }
    terminalActions.closeTerminalSession(terminalId, activeThreadRef);
    storeCloseTerminal(activeThreadRef, terminalId);
    focusActiveDrawerTerminal(activeThreadRef);
  };
  const requestCloseTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closeTerminal(terminalId);
      }
    });
  };
  const requestCloseTerminalStable = useStableCallback(requestCloseTerminal);
  const requestClosePanelTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closePanelTerminal(terminalId);
      }
    });
  };
  const requestClosePanelTerminalStable = useStableCallback(requestClosePanelTerminal);
  const openTerminalIfClosed = () => {
    if (!tiled && !terminalUiState.terminalOpen) setTerminalOpen(true);
  };
  // Narrow layouts retain the drawer; tiled workspaces route every entry point to an area.
  const shortcuts = {
    "terminal.toggle": () => {
      if (
        !terminalUiState.terminalOpen &&
        !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
        !hasTerminalWriteAccess()
      )
        return false;
      toggleTerminalVisibility();
    },
    "terminal.split": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
        return void splitPanelTerminal();
      }
      openTerminalIfClosed();
      splitTerminal();
    },
    "terminal.splitVertical": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
        return void splitPanelTerminal("vertical");
      }
      openTerminalIfClosed();
      splitTerminal("vertical");
    },
    "terminal.close": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (
        (tiled || terminalFocusOwner === "right-panel") &&
        activeRightPanelSurface?.kind === "terminal"
      ) {
        requestClosePanelTerminal(activeRightPanelSurface.activeTerminalId);
        return;
      }
      if (!tiled && terminalUiState.terminalOpen)
        requestCloseTerminal(terminalUiState.activeTerminalId);
    },
    "terminal.new": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (tiled || terminalFocusOwner === "right-panel") return void addTerminalSurface();
      openTerminalIfClosed();
      createNewTerminal();
    },
  } satisfies ChatShortcutCommands;
  return {
    shortcuts,
    activatePanelTerminalStable,
    activatePanelTerminalForSurfaceStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    createNewTerminalStable,
    lastInvokedScriptByProjectId,
    requestClosePanelTerminalStable,
    requestCloseTerminalStable,
    runProjectScriptStable,
    runShellCommandStable,
    setTerminalOpenStable,
    splitPanelTerminalStable,
    splitPanelTerminalForSurfaceStable,
    splitPanelTerminalVerticalStable,
    splitTerminalStable,
    toggleTerminalVisibilityStable,
  };
}
