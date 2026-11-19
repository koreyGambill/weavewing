import { useAtomValue } from "@effect/atom-react";
import { selectRunningSubprocessTerminalIds } from "@t3tools/client-runtime/state/terminal";
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import * as Schema from "effect/Schema";
import { Maximize2, Minimize2, SquareTerminal } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  clampDropdownTerminalHeight,
  DROPDOWN_TERMINAL_DEFAULT_HEIGHT,
  dropdownTerminalRef,
  dropdownTerminalToFocus,
} from "../dropdownTerminal.logic";
import { useDropdownTerminalStore } from "../dropdownTerminalStore";
import { isElectron } from "../env";
import { useDefaultFolder } from "../hooks/useScratchProject";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useRightPanelSurfaceClose } from "../hooks/useRightPanelSurfaceClose";
import { shortcutLabelForCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { focusTerminal, isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import {
  selectThreadRightPanelState,
  selectThreadTileLayout,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { registerCommands } from "../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { CONVERSATION_TAB_ID } from "../threadTileLayout";
import { ThreadTileWorkspace } from "./chat/ThreadTileWorkspace";
import type { TileSurfaceActions } from "./SurfaceTabContent";
import { useMoveToThreadMenu } from "./terminal/useTerminalMoveMenus";
import { useThreadTerminalActions } from "./terminal/useThreadTerminalActions";
import ThreadTerminalTile from "./ThreadTerminalTile";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const HEIGHT_STORAGE_KEY = "t3code:dropdown-terminal-height";
const NO_PENDING_SURFACES: ReadonlySet<string> = new Set();
const noop = () => {};

/** Owns the toggle key and mounts the panel only while it is open. */
export function DropdownTerminalHost() {
  const open = useDropdownTerminalStore((state) => state.open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the app-wide toggle key once
  useEffect(
    () =>
      registerCommands(
        {
          "terminal.dropdown": (event) => {
            event.preventDefault();
            useDropdownTerminalStore.getState().toggle();
          },
          "terminal.dropdownExpand": (event) => {
            event.preventDefault();
            const store = useDropdownTerminalStore.getState();
            if (store.open) {
              store.toggleExpanded();
              return;
            }
            if (!store.expanded) store.toggleExpanded();
            store.toggle();
          },
          // The thread's terminal sits under the panel, so the panel gives way to it.
          "terminal.toggle": () => {
            useDropdownTerminalStore.getState().close();
            return false;
          },
        },
        { capture: true },
      ),
    [],
  );
  // Appended after any open dialog, such as Settings, so it opens above it; its own menus
  // and tooltips open later still and stay above it.
  return open ? createPortal(<DropdownTerminalPanel />, document.body) : null;
}

/** The titlebar button beside Layouts. */
export function DropdownTerminalButton() {
  const open = useDropdownTerminalStore((state) => state.open);
  const shortcut = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "terminal.dropdown",
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-toggle"
            size="icon-sm"
            aria-label="Drop-down terminal"
            aria-pressed={open}
            onClick={() => useDropdownTerminalStore.getState().toggle()}
          />
        }
      >
        <SquareTerminal className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Drop-down terminal{shortcut ? ` (${shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function HeaderControl(props: {
  label: string;
  keys: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={props.label} onClick={props.onClick} />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.label}
        {props.keys ? ` (${props.keys})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function DropdownTerminalPanel() {
  const expanded = useDropdownTerminalStore((state) => state.expanded);
  const [height, setHeight] = useLocalStorage(
    HEIGHT_STORAGE_KEY,
    DROPDOWN_TERMINAL_DEFAULT_HEIGHT,
    Schema.Finite,
  );
  const folder = useDefaultFolder();
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  // Moves the edge directly so a drag re-renders nothing until it ends.
  const dragTo = (event: ReactPointerEvent) => {
    const active = drag.current;
    const panel = panelRef.current;
    if (!active || !panel || active.pointerId !== event.pointerId) return null;
    const next = clampDropdownTerminalHeight(
      active.startHeight + event.clientY - active.startY,
      window.innerHeight,
    );
    panel.style.height = `${next}px`;
    return next;
  };

  return (
    <section
      ref={panelRef}
      aria-label="Drop-down terminal"
      data-dropdown-terminal
      className={cn(
        "fixed inset-x-0 top-[var(--workspace-topbar-height)] z-50 flex max-h-[calc(100dvh-var(--workspace-topbar-height)-2rem)] flex-col border-b bg-background shadow-xl transition-transform duration-150 ease-out starting:-translate-y-full motion-reduce:transition-none [-webkit-app-region:no-drag]",
        expanded && "bottom-0 max-h-none",
      )}
      style={
        expanded ? undefined : { height: clampDropdownTerminalHeight(height, window.innerHeight) }
      }
    >
      {folder ? (
        <DropdownTerminalWorkspace key={folder.environmentId} folder={folder} />
      ) : (
        <p className="m-auto p-6 text-sm text-muted-foreground">
          No connected machine offers a default folder for terminals.
        </p>
      )}
      {expanded ? null : (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize drop-down terminal"
          className="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-row-resize touch-none hover:bg-border"
          onPointerDown={(event) => {
            if (event.button !== 0 || !panelRef.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startHeight: panelRef.current.getBoundingClientRect().height,
            };
          }}
          onPointerMove={(event) => void dragTo(event)}
          onPointerUp={(event) => {
            const next = dragTo(event);
            drag.current = null;
            if (next !== null) setHeight(next);
          }}
          onPointerCancel={() => {
            drag.current = null;
            if (panelRef.current) panelRef.current.style.height = `${height}px`;
          }}
          onDoubleClick={() => setHeight(DROPDOWN_TERMINAL_DEFAULT_HEIGHT)}
        />
      )}
    </section>
  );
}

function DropdownTerminalWorkspace({
  folder,
}: {
  folder: NonNullable<ReturnType<typeof useDefaultFolder>>;
}) {
  const ref = dropdownTerminalRef(folder.environmentId);
  const expanded = useDropdownTerminalStore((state) => state.expanded);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canOperate = useEnvironmentScope(folder.environmentId, AuthTerminalOperateScope);
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, ref),
  );
  const knownSessions = useKnownTerminalSessions({
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  });
  const summaryFor = (terminalId: string) =>
    knownSessions?.find((session) => session.target.terminalId === terminalId)?.state.summary ??
    null;
  const terminals = panelState.surfaces.filter(
    (surface): surface is Extract<RightPanelSurface, { kind: "terminal" }> =>
      surface.kind === "terminal",
  );
  const terminalLabelsById = new Map(
    terminals.map((surface) => [
      surface.resourceId,
      resolveTerminalSessionLabel(surface.resourceId, summaryFor(surface.resourceId)),
    ]),
  );
  const terminalActions = useThreadTerminalActions(ref);
  const moveMenu = useMoveToThreadMenu({ dropdownRef: ref, machine: folder.machine });
  const close = useRightPanelSurfaceClose({ threadRef: ref, terminalLabelsById });

  const addTerminal = () => {
    if (!canOperate) return;
    const terminalId = terminalActions.allocateTerminalId();
    const store = useRightPanelStore.getState();
    // The tile attaches with this folder, which starts the shell.
    store.openTerminal(ref, terminalId, { cwd: folder.root, worktreePath: null });
    store.applyTileAction(ref, { type: "close-tab", tabId: CONVERSATION_TAB_ID });
    focusTerminal(ref, terminalId);
  };

  const focusOnOpen = useEffectEvent(() => {
    const store = useRightPanelStore.getState();
    const terminalId = dropdownTerminalToFocus(
      selectThreadTileLayout(store.byThreadKey, ref),
      selectThreadRightPanelState(store.byThreadKey, ref).surfaces,
    );
    if (terminalId === null) addTerminal();
    else focusTerminal(ref, terminalId);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each opening mounts the panel, which focuses its terminal or starts one
  useEffect(() => focusOnOpen(), []);

  // Closing the last terminal hides the drop-down; the next opening starts a fresh one.
  const [hadTerminals, setHadTerminals] = useState(false);
  if (terminals.length > 0 && !hadTerminals) setHadTerminals(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the panel through its store once its last terminal is gone
  useEffect(() => {
    if (hadTerminals && terminals.length === 0) useDropdownTerminalStore.getState().close();
  }, [hadTerminals, terminals.length]);

  // A shell that exited has nothing left to confirm.
  const closeExited = (terminalId: string) => {
    const surface = terminals.find((entry) => entry.resourceId === terminalId);
    if (!surface) return;
    terminalActions.closeTerminalSession(terminalId);
    useRightPanelStore.getState().closeTerminal(ref, surface.id, terminalId);
  };

  const panels: TileSurfaceActions = {
    keybindings,
    getShortcutContext: () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: true,
      previewFocus: false,
      previewOpen: false,
      editableFocus: isEditableFocused(document.activeElement),
      isWeb: !isElectron,
      isDesktop: isElectron,
    }),
    surfaces: panelState.surfaces,
    environmentId: folder.environmentId,
    activeSurfaceId: panelState.activeSurfaceId,
    pendingSurfaceIds: NO_PENDING_SURFACES,
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById,
    onActivate: (surface) => useRightPanelStore.getState().activateSurface(ref, surface.id),
    onCloseSurface: close.closeSurface,
    onCloseOtherSurfaces: close.closeOtherSurfaces,
    onCloseSurfacesToRight: close.closeSurfacesToRight,
    onCloseAllSurfaces: close.closeAllSurfaces,
    onMoveSurface: (surfaceId, toIndex) =>
      useRightPanelStore.getState().moveSurface(ref, surfaceId, toIndex),
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: addTerminal,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: false,
    terminalAvailable: canOperate,
    diffAvailable: false,
    filesAvailable: false,
    pullRequestAvailable: false,
    pullRequestsAvailable: false,
    deviceAvailable: false,
    terminalMoveMenu: moveMenu,
  };

  const header = (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b pr-1 pl-3">
      <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="shrink-0 text-sm font-medium">Terminal</h2>
      <p className="min-w-0 truncate text-xs text-muted-foreground">
        {folder.machine} · {folder.label}
      </p>
      <div className="ml-auto flex shrink-0 items-center">
        <HeaderControl
          label={expanded ? "Restore drop-down height" : "Fill the window"}
          keys={shortcutLabelForCommand(keybindings, "terminal.dropdownExpand")}
          onClick={() => useDropdownTerminalStore.getState().toggleExpanded()}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </HeaderControl>
      </div>
    </header>
  );

  return (
    <ThreadTileWorkspace
      threadRef={ref}
      projectId={null}
      newThread={false}
      header={header}
      conversation={null}
      panels={panels}
      runningTerminalIds={selectRunningSubprocessTerminalIds(knownSessions ?? [])}
      onCloseTileSurfaces={close.closeSurfacesWithoutTerminalPrompt}
      terminalsOnly
      overlay
      onMaximizeOnlyTile={() => useDropdownTerminalStore.getState().toggleExpanded()}
      renderSurface={(surface, visible) =>
        surface.kind === "terminal" ? (
          <ThreadTerminalTile
            visible={visible}
            threadRef={ref}
            threadId={ref.threadId}
            terminalId={surface.resourceId}
            cwd={surface.launchContext?.cwd ?? summaryFor(surface.resourceId)?.cwd ?? folder.root}
            worktreePath={null}
            terminalLabel={resolveTerminalSessionLabel(
              surface.resourceId,
              summaryFor(surface.resourceId),
            )}
            keybindings={keybindings}
            onCloseTerminal={closeExited}
            moveMenu={moveMenu(surface.resourceId)}
          />
        ) : null
      }
    />
  );
}
