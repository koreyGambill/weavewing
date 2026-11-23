import { useAtomValue } from "@effect/atom-react";
import { selectRunningSubprocessTerminalIds } from "@t3tools/client-runtime/state/terminal";
import {
  availableScratchWorkspaceRoot,
  scratchWorkspaceLabel,
} from "@t3tools/client-runtime/operations/projects";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import * as Schema from "effect/Schema";
import {
  Check,
  ChevronDown,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  Plus,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
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
  dropdownTerminalTabAt,
  dropdownTerminalTarget,
  dropdownTerminalToFocus,
} from "../dropdownTerminal.logic";
import {
  activeDropdownTerminalTab,
  type DropdownTerminalTab,
  type DropdownTerminalTarget,
  useDropdownTerminalStore,
} from "../dropdownTerminalStore";
import { isElectron } from "../env";
import { useDefaultFolderEnvironmentId } from "../hooks/useScratchProject";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useRightPanelSurfaceClose } from "../hooks/useRightPanelSurfaceClose";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { confirmTerminalClose, isTerminalCloseConfirmPending } from "../lib/terminalCloseConfirm";
import { focusTerminal, isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import {
  selectThreadRightPanelState,
  selectThreadTileLayout,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { registerCommands } from "../shortcuts/dispatcher";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../state/session";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { CONVERSATION_TAB_ID } from "../threadTileLayout";
import { ThreadTileWorkspace } from "./chat/ThreadTileWorkspace";
import type { TileSurfaceActions } from "./SurfaceTabContent";
import { useMoveToThreadMenu } from "./terminal/useTerminalMoveMenus";
import { useThreadTerminalActions } from "./terminal/useThreadTerminalActions";
import ThreadTerminalTile from "./ThreadTerminalTile";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const HEIGHT_STORAGE_KEY = "t3code:dropdown-terminal-height";
const PIN_STORAGE_KEY = "t3code:dropdown-terminal-pinned";
const NO_PENDING_SURFACES: ReadonlySet<string> = new Set();
const TAB_JUMP_COMMAND = /^terminal\.dropdownTab\.[1-9]$/;
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
            data-dropdown-terminal-toggle
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
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.pressed === undefined ? "ghost" : "ghost-toggle"}
            size="icon-sm"
            aria-label={props.label}
            aria-pressed={props.pressed}
            onClick={props.onClick}
          />
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

function DropdownTerminalTabStrip(props: {
  tabs: readonly DropdownTerminalTab[];
  activeTabId: string;
  targetFor: (tab: DropdownTerminalTab) => DropdownTerminalTarget | null;
  keybindings: ResolvedKeybindingsConfig;
  onAdd: () => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div
        role="tablist"
        aria-label="Drop-down terminal tabs"
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {props.tabs.map((tab, index) => {
          const target = props.targetFor(tab);
          const label = tab.name ?? target?.label ?? "Choose machine";
          const active = tab.id === props.activeTabId;
          const jumpKeys =
            index < 9
              ? shortcutLabelForCommand(
                  props.keybindings,
                  `terminal.dropdownTab.${index === props.tabs.length - 1 ? 9 : index + 1}` as KeybindingCommand,
                )
              : null;
          return (
            <div
              key={tab.id}
              data-external={target?.external ? "" : undefined}
              className={cn(
                "group/tab flex h-7 max-w-48 min-w-0 shrink-0 items-center rounded-md border text-xs",
                target?.external
                  ? "border-external/50 bg-external/10 text-external-foreground"
                  : "border-transparent text-muted-foreground",
                active &&
                  (target?.external
                    ? "border-external bg-external/25"
                    : "border-border bg-accent text-foreground"),
              )}
            >
              {renamingId === tab.id ? (
                <input
                  aria-label="Tab name"
                  autoFocus
                  defaultValue={tab.name ?? ""}
                  placeholder={target?.label ?? "Tab name"}
                  className="h-full w-32 min-w-0 bg-transparent px-2 outline-none"
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={(event) => {
                    useDropdownTerminalStore
                      .getState()
                      .renameTab(tab.id, event.currentTarget.value);
                    setRenamingId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setRenamingId(null);
                    }
                  }}
                />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className="flex h-full min-w-0 items-center px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        onClick={() => useDropdownTerminalStore.getState().selectTab(tab.id)}
                        onDoubleClick={() => setRenamingId(tab.id)}
                        onKeyDown={(event) => {
                          if (event.key === "F2") setRenamingId(tab.id);
                        }}
                      />
                    }
                  >
                    <span className="truncate">{label}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    {target ? `${label} · ${target.label}` : label}
                    {target?.external ? " (external)" : ""}
                    {jumpKeys ? ` (${jumpKeys})` : ""}. Double-click to rename.
                  </TooltipPopup>
                </Tooltip>
              )}
              {active && renamingId !== tab.id && target && (
                <CloseDropdownTabButton
                  tab={tab}
                  environmentId={target.environmentId}
                  label={label}
                />
              )}
            </div>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New drop-down tab"
              onClick={props.onAdd}
            />
          }
        >
          <Plus />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New drop-down tab</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** Closes every terminal in the tab, asking first when one is running a command. */
function CloseDropdownTabButton(props: {
  tab: DropdownTerminalTab;
  environmentId: EnvironmentId;
  label: string;
}) {
  const ref = dropdownTerminalRef(props.environmentId, props.tab.id);
  const knownSessions = useKnownTerminalSessions({
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  });
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, ref).surfaces,
  );
  const terminalLabelsById = new Map(
    surfaces.flatMap((surface) =>
      surface.kind === "terminal"
        ? [
            [
              surface.resourceId,
              resolveTerminalSessionLabel(
                surface.resourceId,
                knownSessions?.find((session) => session.target.terminalId === surface.resourceId)
                  ?.state.summary ?? null,
              ),
            ] as const,
          ]
        : [],
    ),
  );
  const close = useRightPanelSurfaceClose({ threadRef: ref, terminalLabelsById });
  const closeTab = async () => {
    const terminals = [...terminalLabelsById].map(([terminalId, label]) => ({ terminalId, label }));
    if (terminals.length > 0 && !(await confirmTerminalClose(ref, terminals))) return;
    close.closeSurfacesWithoutTerminalPrompt(surfaces);
    useDropdownTerminalStore.getState().removeTab(props.tab.id);
  };
  return (
    <button
      type="button"
      aria-label={`Close ${props.label}`}
      className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm opacity-70 outline-none hover:bg-foreground/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-3.5"
      onClick={() => void closeTab()}
    >
      <X />
    </button>
  );
}

function DropdownTerminalPanel() {
  const expanded = useDropdownTerminalStore((state) => state.expanded);
  const [pinned, setPinned] = useLocalStorage(PIN_STORAGE_KEY, false, Schema.Boolean);
  const togglePinFromShortcut = useEffectEvent(() => setPinned((value) => !value));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the pin command is available while the panel is open
  useEffect(
    () =>
      registerCommands(
        {
          "terminal.dropdownPin": (event) => {
            if (!event.repeat) togglePinFromShortcut();
          },
        },
        { capture: true },
      ),
    [],
  );
  const [height, setHeight] = useLocalStorage(
    HEIGHT_STORAGE_KEY,
    DROPDOWN_TERMINAL_DEFAULT_HEIGHT,
    Schema.Finite,
  );
  const tabs = useDropdownTerminalStore((state) => state.tabs);
  const activeTab = useDropdownTerminalStore(activeDropdownTerminalTab);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const defaultEnvironmentId = useDefaultFolderEnvironmentId(environments);
  const threadRef = useThreadRouteRef();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const allowed = useEnvironmentsWithScope(connected, AuthTerminalOperateScope);
  const targetFor = (environmentId: EnvironmentId | null) => {
    const entry = environments.find((candidate) => candidate.environmentId === environmentId);
    return entry ? dropdownTerminalTarget(entry, primaryEnvironmentId, isElectron) : null;
  };
  const tabTarget = (tab: DropdownTerminalTab) =>
    targetFor(tab.target?.environmentId ?? defaultEnvironmentId) ?? tab.target;
  const target = tabTarget(activeTab);
  const targetEnvironmentId = target?.environmentId ?? null;
  const environment = environments.find((entry) => entry.environmentId === targetEnvironmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the tab remembers its machine as last seen, so it keeps it across disconnects and restarts
  useEffect(() => {
    const saved = activeTab.target;
    if (
      target !== null &&
      (saved === null || saved.label !== target.label || saved.external !== target.external)
    ) {
      useDropdownTerminalStore.getState().setTabTarget(activeTab.id, target);
    }
  }, [activeTab.id, activeTab.target, target]);
  const disconnected =
    targetEnvironmentId !== null && environment?.connection.phase !== "connected";
  const root = availableScratchWorkspaceRoot(
    environment?.connection.phase,
    environment?.serverConfig,
  );
  const folderLabel = root && (scratchWorkspaceLabel(environment?.serverConfig) ?? root);
  const machineChoices = connected.map((entry) => ({
    target: dropdownTerminalTarget(entry, primaryEnvironmentId, isElectron),
    unavailable: !availableScratchWorkspaceRoot(entry.connection.phase, entry.serverConfig)
      ? "No default folder"
      : !allowed.has(entry.environmentId)
        ? "Terminal permission required"
        : null,
  }));
  const threadChoice = machineChoices.find(
    (choice) =>
      choice.target.environmentId === threadRef?.environmentId && choice.unavailable === null,
  );
  const changedMachine = useRef(false);
  const select = (choice: DropdownTerminalTarget) => {
    changedMachine.current = choice.environmentId !== targetEnvironmentId;
    useDropdownTerminalStore.getState().setTabTarget(activeTab.id, choice);
  };
  const panelRef = useRef<HTMLElement>(null);
  const jumpToTab = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) return false;
    const command = resolveShortcutCommand(
      event,
      keybindings.filter((binding) => TAB_JUMP_COMMAND.test(binding.command)),
      { context: { terminalFocus: isTerminalFocused(), dropdownTerminalFocus: true } },
    );
    const tab = command === null ? null : dropdownTerminalTabAt(tabs, Number(command.at(-1)));
    if (tab === null) return false;
    // The focused shell would otherwise also read the key.
    event.preventDefault();
    event.stopPropagation();
    useDropdownTerminalStore.getState().selectTab(tab.id);
    return true;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tab jump keys apply while focus is in the open panel
  useEffect(() => registerCommands({}, { capture: true, onKeyDown: jumpToTab }), []);
  const pointerStartedOutside = useRef(false);
  const insideClicks = useRef(new WeakSet<Event>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismisses on document clicks, including controls that stop propagation
  useEffect(() => {
    if (pinned) return;
    let pending: number | undefined;
    const isOutside = (event: MouseEvent) =>
      !event
        .composedPath()
        .some(
          (node) =>
            node === panelRef.current ||
            (node instanceof Element &&
              (node.matches("[data-dropdown-terminal-toggle], [data-context-menu]") ||
                (isTerminalCloseConfirmPending() &&
                  node.matches(
                    '[data-slot="alert-dialog-viewport"], [data-slot="alert-dialog-backdrop"]',
                  )))),
        );
    const onPointerDown = (event: PointerEvent) => {
      pointerStartedOutside.current = event.isPrimary && event.button === 0 && isOutside(event);
    };
    const onClick = (event: MouseEvent) => {
      const startedOutside = pointerStartedOutside.current;
      pointerStartedOutside.current = false;
      if (!startedOutside || event.detail === 0 || !isOutside(event)) return;
      window.clearTimeout(pending);
      // Let React mark portaled clicks and let the clicked control handle its event and focus.
      pending = window.setTimeout(() => {
        if (!insideClicks.current.has(event)) useDropdownTerminalStore.getState().close();
      }, 0);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      window.clearTimeout(pending);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [pinned]);
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
      onPointerDownCapture={() => {
        pointerStartedOutside.current = false;
      }}
      onClickCapture={(event) => insideClicks.current.add(event.nativeEvent)}
      className={cn(
        "fixed inset-x-0 top-[var(--workspace-topbar-height)] z-50 flex max-h-[calc(100dvh-var(--workspace-topbar-height)-2rem)] flex-col border-b bg-background shadow-xl transition-transform duration-150 ease-out starting:-translate-y-full motion-reduce:transition-none [-webkit-app-region:no-drag]",
        expanded && "bottom-0 max-h-none",
      )}
      style={
        expanded ? undefined : { height: clampDropdownTerminalHeight(height, window.innerHeight) }
      }
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b pr-1 pl-3">
        <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="sr-only">Terminal</h2>
        <DropdownTerminalTabStrip
          tabs={tabs}
          activeTabId={activeTab.id}
          targetFor={tabTarget}
          keybindings={keybindings}
          onAdd={() => useDropdownTerminalStore.getState().addTab(target)}
        />
        <div className="min-w-0 shrink-0">
          <Menu
            onOpenChange={(open) => {
              if (open) changedMachine.current = false;
            }}
          >
            <MenuTrigger
              aria-label={`Run on ${target?.label ?? "Choose machine"}`}
              render={<Button variant="outline" size="compact" className="max-w-full" />}
            >
              <span className="shrink-0">Run on</span>
              <span className="max-w-40 truncate">{target?.label ?? "Choose machine"}</span>
              <ChevronDown />
            </MenuTrigger>
            <MenuPopup align="start" finalFocus={() => !changedMachine.current}>
              {threadChoice && (
                <>
                  <MenuItem onClick={() => select(threadChoice.target)}>
                    Use current thread’s machine
                  </MenuItem>
                  <MenuSeparator />
                </>
              )}
              {machineChoices.map((choice) => (
                <MenuItem
                  key={choice.target.environmentId}
                  disabled={choice.unavailable !== null}
                  onClick={() => select(choice.target)}
                >
                  <span className="min-w-0 wrap-anywhere">{choice.target.label}</span>
                  {choice.unavailable && <MenuItemDetail>{choice.unavailable}</MenuItemDetail>}
                  {choice.target.environmentId === targetEnvironmentId && (
                    <Check aria-label="Selected" />
                  )}
                </MenuItem>
              ))}
              {machineChoices.length === 0 && <MenuItem disabled>No connected machines</MenuItem>}
            </MenuPopup>
          </Menu>
        </div>
        {folderLabel && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="hidden max-w-48 min-w-0 truncate text-xs text-muted-foreground lg:block" />
              }
            >
              {folderLabel}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{folderLabel}</TooltipPopup>
          </Tooltip>
        )}
        <div className="ml-auto flex shrink-0 items-center">
          <HeaderControl
            label={expanded ? "Restore drop-down height" : "Fill the window"}
            keys={shortcutLabelForCommand(keybindings, "terminal.dropdownExpand")}
            pressed={expanded}
            onClick={() => useDropdownTerminalStore.getState().toggleExpanded()}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </HeaderControl>
          <HeaderControl
            label="Pin drop-down terminal"
            keys={shortcutLabelForCommand(keybindings, "terminal.dropdownPin")}
            pressed={pinned}
            onClick={() => setPinned((value) => !value)}
          >
            {pinned ? <PinOff /> : <Pin />}
          </HeaderControl>
        </div>
      </header>
      {(disconnected || target?.external) && (
        <div
          role={disconnected ? "status" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2 border-b px-3 py-2",
            disconnected
              ? "border-destructive/45 bg-destructive/20 text-destructive-foreground"
              : "border-warning/45 bg-warning/25 text-warning-foreground",
          )}
        >
          <TriangleAlert aria-hidden className="size-5 shrink-0" />
          <strong className="text-sm font-bold">
            {disconnected ? "Disconnected" : "External"}
          </strong>
          <span className="text-xs text-foreground">
            {disconnected
              ? "Reconnect or choose another machine."
              : "Commands run on another machine."}
          </span>
        </div>
      )}
      {target && root !== null ? (
        <DropdownTerminalWorkspace
          key={`${activeTab.id}:${target.environmentId}`}
          tabId={activeTab.id}
          target={target}
          root={root}
        />
      ) : disconnected ? null : (
        <p role="status" className="m-auto p-6 text-sm text-muted-foreground">
          {target
            ? "This machine has no default folder for terminals."
            : "No connected machine offers a default folder for terminals."}
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
  tabId,
  target,
  root,
}: {
  tabId: string;
  target: DropdownTerminalTarget;
  root: string;
}) {
  const ref = dropdownTerminalRef(target.environmentId, tabId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canOperate = useEnvironmentScope(target.environmentId, AuthTerminalOperateScope);
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
  const moveMenu = useMoveToThreadMenu({ dropdownRef: ref, machine: target.label });
  const close = useRightPanelSurfaceClose({ threadRef: ref, terminalLabelsById });

  const addTerminal = (sourceTabId?: string) => {
    if (!canOperate) return;
    const source = terminals.find((surface) => surface.id === sourceTabId);
    const cwd =
      (source && (summaryFor(source.resourceId)?.cwd ?? source.launchContext?.cwd)) ?? root;
    const terminalId = terminalActions.allocateTerminalId();
    const store = useRightPanelStore.getState();
    store.openTerminal(ref, terminalId, { cwd, worktreePath: null });
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening or restoring the operate grant focuses or starts the machine's shell
  useEffect(() => {
    if (canOperate) focusOnOpen();
  }, [canOperate]);

  // Closing a tab's last terminal closes the tab; the only tab hides the drop-down instead.
  const [hadTerminals, setHadTerminals] = useState(false);
  if (terminals.length > 0 && !hadTerminals) setHadTerminals(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the panel through its store once its last terminal is gone
  useEffect(() => {
    if (hadTerminals && terminals.length === 0)
      useDropdownTerminalStore.getState().removeTab(tabId);
  }, [hadTerminals, tabId, terminals.length]);

  // A shell that exited has nothing left to confirm.
  const closeExited = (terminalId: string, _target?: unknown, sessionId?: string | null) => {
    const surface = terminals.find((entry) => entry.resourceId === terminalId);
    if (!surface) return;
    terminalActions.closeTerminalSession(terminalId, ref, sessionId);
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
    environmentId: target.environmentId,
    activeSurfaceId: panelState.activeSurfaceId,
    pendingSurfaceIds: NO_PENDING_SURFACES,
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById,
    onActivate: (surface) => {
      useRightPanelStore.getState().activateSurface(ref, surface.id);
      if (surface.kind === "terminal") focusTerminal(ref, surface.resourceId);
    },
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

  if (!canOperate && terminals.length === 0) {
    return (
      <p role="status" className="m-auto p-6 text-sm text-muted-foreground">
        You can’t operate terminals on this machine.
      </p>
    );
  }

  return (
    <ThreadTileWorkspace
      threadRef={ref}
      projectId={null}
      newThread={false}
      header={null}
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
            cwd={surface.launchContext?.cwd ?? summaryFor(surface.resourceId)?.cwd ?? root}
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
