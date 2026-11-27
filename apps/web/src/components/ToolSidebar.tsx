import { useAtomValue } from "@effect/atom-react";
import { useRouter, useRouterState, type ParsedLocation } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  ChevronDownIcon,
  EyeOffIcon,
  LockIcon,
  LockOpenIcon,
  Maximize2,
  Minimize2,
  PanelRight,
  PinIcon,
  X,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { isElectron } from "../env";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useResizeDrag } from "../hooks/useResizeDrag";
import { useStableCallback } from "../hooks/useStableCallback";
import { shortcutLabelForCommand } from "../keybindings";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { useThreadShell } from "../state/entities";
import { DeferEnvironmentQueries } from "../state/query";
import { useEnvironmentThread } from "../state/threads";
import { primaryServerKeybindingsAtom } from "../state/server";
import { readSelectedThreadRef } from "../threadContextSidebar";
import { useThreadContextSidebarStore } from "../threadContextSidebarStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import {
  completeSideAreaHandoff,
  isSideAreaHandoffArriving,
  provideSideAreaContext,
  sideAreaOpenRequests,
  takeSideAreaFocusRequest,
  useToolSidebarStore,
} from "../toolSidebarStore";
import { HostedView, useOpenViewPage } from "../views/ViewPageHost";
import {
  PANEL_VIEW_DEFINITIONS,
  viewDefinition,
  type ViewDefinition,
  type ViewSlots,
  type ViewTarget,
} from "../views/viewRegistry";
import { DropdownTerminalButton } from "./DropdownTerminal";
import { useStatusSignal } from "./statusSources/StatusSources";
import { StatusSourceDot } from "./statusSources/StatusSourceIcon";
import { useRouteDraft, useSideAreaDetailsSetter, useSideAreaThreadRef } from "./threadToolsHost";
import {
  SIDE_AREA_WIDE_MEDIA_QUERY,
  canHideView,
  describeLockedThread,
  resolveSideAreaWidth,
  resolveViewLayout,
  type LockedThreadState,
  type ViewId,
  SIDE_AREA_MAX_WIDTH,
  SIDE_AREA_MIN_WIDTH,
} from "./ToolSidebar.logic";
import { Button } from "./ui/button";
import { Empty, EmptyDescription } from "./ui/empty";
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
import { useMobileSidebarSheetMounted, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkspaceTitlebarControlsHost, WorkspaceTitlebarHost } from "./WorkspaceTitlebar";

/** A thread view starts its requests once the selection has rested this long. */
export const SIDE_AREA_SETTLE_MS = 250;
const SIDE_AREA_COVER_VARIABLE = "--side-area-cover-right";
// Popups and dialogs portal outside the side area, and the drop-down terminal sits beside it;
// using any of them is not a click outside it.
const LAYER_SELECTOR =
  '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [data-context-menu], [data-side-area-toggle], [data-dropdown-terminal], [data-dropdown-terminal-toggle]';

function sideAreaRoute({ pathname, state }: ParsedLocation) {
  return { pathname, key: state.__TSR_key, index: state.__TSR_index };
}

function threadKey(ref: ScopedThreadRef | null) {
  return ref ? `${ref.environmentId}:${ref.threadId}` : null;
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .cm-editor, .xterm',
    ) !== null
  );
}

function isEditorTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest(".monaco-editor, .cm-editor, .xterm") !== null;
}

function openLayerVisible() {
  return Array.from(
    document.querySelectorAll(
      '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
    ),
  ).some((popup) => popup.checkVisibility({ checkVisibilityCSS: true }));
}

/** Whether the side area shows maximized: a view with a page opens its page instead. */
function shownMaximized(state: { readonly maximized: boolean; readonly view: ViewId }) {
  return state.maximized && !viewDefinition(state.view).page;
}

/**
 * The side area: one view at a time on the right, covering the content instead of resizing it.
 * Its thread views follow the selected thread unless locked; Pin keeps it open.
 */
export function ToolSidebarLayout({ children }: { children: ReactNode }) {
  const open = useToolSidebarStore((state) => state.open);
  const width = useToolSidebarStore((state) => state.width);
  const maximized = useToolSidebarStore(shownMaximized);
  const pinned = useToolSidebarStore((state) => state.pinned);
  const { state: statusState } = useStatusSignal();
  const statusAlert = statusState === "fail" || statusState === "warn" ? statusState : null;
  const [availableWidth, setAvailableWidth] = useState(1280);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  const isWide = useMediaQuery(SIDE_AREA_WIDE_MEDIA_QUERY);
  const [titlebarHost, setTitlebarHost] = useState<HTMLElement | null>(null);
  const [titlebarControlsHost, setTitlebarControlsHost] = useState<HTMLElement | null>(null);
  const shortcut = shortcutLabelForCommand(keybindings, "toolSidebar.toggle");
  const coversContent = maximized && isWide && open;
  const panelWidth = isWide
    ? resolveSideAreaWidth(width, availableWidth)
    : availableWidth < 640
      ? availableWidth
      : Math.min(width, availableWidth);
  const routeThreadKey = useRouterState({
    select: (state) => threadKey(resolveThreadRouteRef(state.matches.at(-1)?.params ?? {})),
  });
  const router = useRouter();
  // The resolved location changes once the matches the thread key comes from have rendered.
  const routePathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname });
  const routeIndex = useRouterState({
    select: (state) => state.resolvedLocation?.state.__TSR_index,
  });
  const routeKey = useRouterState({ select: (state) => state.resolvedLocation?.state.__TSR_key });
  const seenThreadKey = useRef(routeThreadKey);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // The route's thread, and the thread the side area follows there: a focused side chat's, say.
  const readContext = useStableCallback(() => {
    const route = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
    return { route, selected: readSelectedThreadRef(route) };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Switching threads by route, from a link or a shortcut, closes an unpinned side area unless the view was opened for that arrival.
  useEffect(() => {
    if (seenThreadKey.current === routeThreadKey) return;
    seenThreadKey.current = routeThreadKey;
    if (isSideAreaHandoffArriving(sideAreaRoute(router.state.location))) return;
    useToolSidebarStore.getState().dispatch({ type: "routeChanged", context: readContext() });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only a thread switch dismisses; the router is read for the location it switched to.
  }, [routeThreadKey, readContext]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A page's handoff ends on the entry it went to; focus stays in the side area, which the destination's composer leaves alone.
  useEffect(() => {
    const route = { pathname: routePathname, key: routeKey, index: routeIndex };
    if (!completeSideAreaHandoff(route, toggleRef.current)) return;
    const panel = document.querySelector("[data-side-area]");
    if (panel && !panel.contains(document.activeElement)) {
      panel.querySelector<HTMLElement>("header button")?.focus({ preventScroll: true });
    }
  }, [routePathname, routeKey, routeIndex]);
  const sidebar = useSidebar();
  // On a phone the side area is a sheet the thread drawer would cover, so the drawer gives way.
  const closeDrawer = useStableCallback((layout: HTMLElement) => {
    if (sidebar.isMobile && sidebar.mobileSheetMounted) {
      sidebar.setOpenMobile(false, () =>
        layout.querySelector<HTMLElement>("[data-side-area-picker]"),
      );
    }
  });
  const [commandsRef] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    const stopObserving = observeResize(node, () => setAvailableWidth(node.clientWidth));
    setAvailableWidth(node.clientWidth);
    const stopContext = provideSideAreaContext(readContext);
    let requests = sideAreaOpenRequests();
    const stopDrawer = useToolSidebarStore.subscribe((state) => {
      const requested = requests !== sideAreaOpenRequests();
      requests = sideAreaOpenRequests();
      if (state.open && requested) closeDrawer(node);
    });
    const toggle = () => useToolSidebarStore.getState().dispatch({ type: "toggle" });
    const stopMenu = registerMenuAction("toolSidebar.toggle", toggle);
    const stopCommands = registerCommands(
      {
        "toolSidebar.toggle": (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggle();
        },
        "threadContext.toggle": (event) => {
          event.preventDefault();
          event.stopPropagation();
          useToolSidebarStore.getState().dispatch({
            type: "toggleThreadViews",
            collapsedSections: useThreadContextSidebarStore.getState().collapsedSections,
          });
        },
      },
      { capture: true },
    );
    const stopEscape = registerCommands(
      {},
      {
        onKeyDown: (event) => {
          const state = useToolSidebarStore.getState();
          if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !state.open)
            return false;
          const inside =
            event.target instanceof Element && event.target.closest("[data-side-area]") !== null;
          // Outside it, Escape belongs to whatever has focus; a pinned side area ignores it there.
          if (!inside && (state.pinned || isEditableTarget(event.target))) return false;
          // Inside it, a field that uses Escape (clearing a filter) consumes it before it gets here.
          if (inside && isEditorTarget(event.target)) return false;
          if (openLayerVisible()) return false;
          state.dispatch({
            type:
              shownMaximized(state) && window.matchMedia(SIDE_AREA_WIDE_MEDIA_QUERY).matches
                ? "restore"
                : "close",
          });
          event.preventDefault();
          event.stopPropagation();
        },
      },
    );
    return () => {
      stopContext();
      stopDrawer();
      stopObserving();
      stopCommands();
      stopEscape();
      stopMenu();
    };
  });

  return (
    <div
      ref={commandsRef}
      className="relative flex min-h-0 min-w-0 flex-1"
      data-tool-sidebar-layout
    >
      <div
        ref={setTitlebarHost}
        data-workspace-titlebar
        inert={coversContent || undefined}
        className={cn(
          "absolute inset-x-0 top-0 z-10 h-[var(--workspace-topbar-height)] bg-background",
          isElectron && "drag-region",
          coversContent && "[&>*]:invisible",
        )}
      />
      <div
        className={cn("flex min-h-0 min-w-0 flex-1", coversContent && "invisible")}
        inert={coversContent || undefined}
      >
        <WorkspaceTitlebarHost value={titlebarHost}>
          <WorkspaceTitlebarControlsHost value={titlebarControlsHost}>
            {children}
          </WorkspaceTitlebarControlsHost>
        </WorkspaceTitlebarHost>
      </div>
      <div
        className={cn(
          "pointer-events-auto fixed top-[var(--workspace-controls-top)] right-[var(--workspace-tools-controls-right)] z-30 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]",
          mobileSidebarSheetMounted && "hidden",
        )}
      >
        <DropdownTerminalButton />
        <div ref={setTitlebarControlsHost} className="flex" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={toggleRef}
                data-side-area-toggle
                aria-label={
                  statusAlert && !open
                    ? `Toggle side panel (status ${statusAlert === "fail" ? "failing" : "warning"})`
                    : "Toggle side panel"
                }
                aria-pressed={open}
                aria-controls="side-area"
                size="icon-sm"
                variant="ghost"
                onClick={() => useToolSidebarStore.getState().dispatch({ type: "toggle" })}
              />
            }
          >
            <span className="relative flex">
              <PanelRight className="size-4" />
              {!open && statusAlert ? <ToolStatusDot state={statusAlert} /> : null}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Toggle side panel{shortcut ? ` (${shortcut})` : ""}
          </TooltipPopup>
        </Tooltip>
      </div>
      {open ? (
        <SideArea
          maximized={isWide && maximized}
          wide={isWide}
          pinned={pinned}
          width={panelWidth}
          fullWidth={availableWidth}
        />
      ) : null}
    </div>
  );
}

function SideArea({
  maximized,
  wide,
  pinned,
  width,
  fullWidth,
}: {
  maximized: boolean;
  wide: boolean;
  pinned: boolean;
  width: number;
  /** The content area's width, which a maximized side area fills. */
  fullWidth: number;
}) {
  const view = useToolSidebarStore((state) => state.view);
  const locked = useToolSidebarStore((state) => state.locked);
  const dispatch = useToolSidebarStore((state) => state.dispatch);
  const definition = viewDefinition(view);
  const threadRef = useSideAreaThreadRef();
  const lockedState = useLockedThreadState(locked);
  const unlock = () => dispatch({ type: "lock", thread: null });
  const openViewPage = useOpenViewPage();
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const insideClicks = useRef(new WeakSet<Event>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- An unpinned side area closes on a click outside it, which only a document listener sees.
  useEffect(() => {
    if (pinned || !panel) return;
    let pending: number | undefined;
    let startedOutside = false;
    const isOutside = (event: Event) =>
      !event
        .composedPath()
        .some(
          (node) => node === panel || (node instanceof Element && node.matches(LAYER_SELECTOR)),
        );
    const onPointerDown = (event: PointerEvent) => {
      startedOutside = event.isPrimary && event.button === 0 && isOutside(event);
    };
    const onClick = (event: MouseEvent) => {
      const outside = startedOutside;
      startedOutside = false;
      if (!outside || event.detail === 0 || !isOutside(event)) return;
      window.clearTimeout(pending);
      const requests = sideAreaOpenRequests();
      // Clicks in popups opened from inside the side area reach its React tree first, and a click
      // whose own handler opened a view asked for the side area, so neither dismisses it.
      pending = window.setTimeout(() => {
        if (!insideClicks.current.has(event) && sideAreaOpenRequests() === requests) {
          useToolSidebarStore.getState().dispatch({ type: "dismiss" });
        }
      }, 0);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      window.clearTimeout(pending);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [pinned, panel]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The drop-down terminal portals to the body and stops at the side area's left edge, so the edge is published there.
  useEffect(() => {
    if (!panel || !wide) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty(
        SIDE_AREA_COVER_VARIABLE,
        `${Math.max(0, root.clientWidth - panel.getBoundingClientRect().left)}px`,
      );
    publish();
    const stopObserving = observeResize(panel, publish);
    window.addEventListener("resize", publish);
    return () => {
      stopObserving();
      window.removeEventListener("resize", publish);
      root.style.removeProperty(SIDE_AREA_COVER_VARIABLE);
    };
  }, [panel, wide]);

  const resize = useResizeDrag<HTMLButtonElement>((event) => {
    const pane = event.currentTarget.parentElement;
    if (!pane || maximized || !wide) return null;
    const max = resolveSideAreaWidth(
      SIDE_AREA_MAX_WIDTH,
      pane.closest("[data-tool-sidebar-layout]")?.clientWidth ?? SIDE_AREA_MAX_WIDTH,
    );
    return {
      width: pane.getBoundingClientRect().width,
      edge: "left",
      bounds: { min: SIDE_AREA_MIN_WIDTH, max },
      resize(nextWidth) {
        pane.style.width = `${nextWidth}px`;
        return nextWidth;
      },
      finish(nextWidth) {
        dispatch({ type: "resize", width: nextWidth });
      },
      cleanup() {
        pane.style.width = `${width}px`;
      },
    };
  });

  const draft = useRouteDraft(threadRef);
  const setDetails = useSideAreaDetailsSetter();
  const target: ViewTarget =
    definition.scope === "thread" ? { threadRef, draft } : { threadRef, draft: null };
  const layout = resolveViewLayout(definition.compactBelowPx, {
    wide,
    width: maximized ? fullWidth : width,
  });

  return (
    <aside
      id="side-area"
      ref={setPanel}
      aria-label="Side panel"
      data-side-area={maximized ? "maximized" : pinned ? "pinned" : "open"}
      {...workspaceAreaProps("tools", 5)}
      onClickCapture={(event) => insideClicks.current.add(event.nativeEvent)}
      className={cn(
        "workspace-tools-panel absolute right-0 bottom-0 top-[var(--workspace-topbar-height)] z-30 flex min-h-0 min-w-0 flex-col border-l bg-background shadow-xl",
        maximized && "left-0 shadow-none",
      )}
      style={maximized ? undefined : { width }}
    >
      {!maximized && wide ? (
        <button
          type="button"
          aria-label="Resize side panel"
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-border focus-visible:bg-border"
          {...resize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            dispatch({ type: "resize", width: width + (event.key === "ArrowLeft" ? 20 : -20) });
          }}
          onDoubleClick={() => dispatch({ type: "resize", width: 300 })}
        />
      ) : null}
      <header className="flex h-10 shrink-0 items-center gap-1 border-b pr-2 pl-1.5">
        <ViewPicker definition={definition} target={target} />
        <div ref={setActions} className="ms-auto flex min-w-0 items-center" />
        <div
          role="group"
          aria-label="Side panel controls"
          className="flex shrink-0 items-center [-webkit-app-region:no-drag]"
        >
          <HeaderToggle
            label={pinned ? "Unpin side panel" : "Pin side panel"}
            hint={
              pinned
                ? "Pinned: stays open when you switch threads or click elsewhere"
                : "Pin: keep open when you switch threads or click elsewhere"
            }
            pressed={pinned}
            onClick={() => dispatch({ type: "pin" })}
          >
            <PinIcon />
          </HeaderToggle>
          {definition.scope === "thread" ? (
            <HeaderToggle
              label={locked ? "Unlock from thread" : "Lock to thread"}
              hint={
                locked
                  ? "Locked: follow the selected thread again"
                  : "Lock to thread: keep showing this thread when you select another"
              }
              pressed={locked !== null}
              disabled={!locked && !threadRef}
              onClick={() => dispatch({ type: "lock", thread: locked ? null : threadRef })}
            >
              {locked ? <LockIcon /> : <LockOpenIcon />}
            </HeaderToggle>
          ) : null}
          {definition.page ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Open ${definition.title} as a page`}
                    onClick={() => {
                      dispatch({ type: "close" });
                      void openViewPage(definition);
                    }}
                  />
                }
              >
                <Maximize2 />
              </TooltipTrigger>
              <TooltipPopup>Open {definition.title} as a page</TooltipPopup>
            </Tooltip>
          ) : wide ? (
            <HeaderToggle
              label={maximized ? "Restore side panel size" : "Maximize side panel"}
              hint={maximized ? "Restore side panel size" : "Maximize side panel"}
              pressed={maximized}
              onClick={() => dispatch({ type: "maximize" })}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </HeaderToggle>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close side panel"
                  onClick={() => dispatch({ type: "close" })}
                />
              }
            >
              <X />
            </TooltipTrigger>
            <TooltipPopup>Close side panel</TooltipPopup>
          </Tooltip>
        </div>
      </header>
      {lockedState && definition.scope === "thread" ? (
        <LockedThreadBar state={lockedState} onUnlock={unlock} />
      ) : null}
      {lockedState?.kind === "deleted" && definition.scope === "thread" ? (
        <Empty size="compact">
          <EmptyDescription>This thread was deleted.</EmptyDescription>
          <Button size="sm" variant="outline" onClick={unlock}>
            Unlock and follow the selected thread
          </Button>
        </Empty>
      ) : (
        <SideAreaBody
          definition={definition}
          target={target}
          layout={layout}
          width={maximized ? fullWidth : width}
          slots={{ actions, setDetails }}
        />
      )}
    </aside>
  );
}

function HeaderToggle(props: {
  label: string;
  hint: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost-toggle"
            aria-label={props.label}
            aria-pressed={props.pressed}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.hint}</TooltipPopup>
    </Tooltip>
  );
}

function useLockedThreadState(threadRef: ScopedThreadRef | null): LockedThreadState | null {
  const shell = useThreadShell(threadRef);
  // Archived and deleted threads leave the shell list, so only then read the thread itself.
  const readDetail = threadRef !== null && shell === null;
  const detail = useEnvironmentThread(
    readDetail ? threadRef.environmentId : null,
    readDetail ? threadRef.threadId : null,
  );
  if (threadRef === null) return null;
  const thread = Option.getOrNull(detail.data)?.thread ?? null;
  return describeLockedThread({
    shellTitle: shell?.title ?? null,
    detail: readDetail
      ? {
          status: detail.status,
          title: thread?.title ?? null,
          archived: thread?.archivedAt != null,
        }
      : null,
  });
}

function LockedThreadBar({ state, onUnlock }: { state: LockedThreadState; onUnlock: () => void }) {
  const label =
    state.kind === "deleted"
      ? "The locked thread was deleted"
      : state.kind === "loading"
        ? "Locked to a thread that is loading"
        : `Locked to ${state.title}${state.archived ? " (archived)" : ""}`;
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/40 ps-3 pe-2 text-xs text-muted-foreground">
      <LockIcon aria-hidden className="size-3.5 shrink-0" />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
          {state.kind === "named" ? (
            <>
              Locked to <span className="text-foreground">{state.title}</span>
              {state.archived ? " (archived)" : null}
            </>
          ) : (
            label
          )}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {state.kind === "deleted" ? (
        <Button size="xs" variant="ghost" onClick={onUnlock}>
          Unlock
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The view for its target. A thread switch unmounts the old thread's view, cancelling its
 * requests, and mounts the new one at once from what the client already holds; its own requests
 * wait until the selection rests, so walking down the thread list starts one load.
 */
function SideAreaBody({
  definition,
  target,
  layout,
  width,
  slots,
}: {
  definition: ViewDefinition;
  target: ViewTarget;
  layout: "compact" | "full";
  width: number;
  slots: ViewSlots;
}) {
  // A view that spans threads keeps its content and requests when the thread changes.
  const key = definition.scope === "thread" ? threadKey(target.threadRef) : null;
  const [settledKey, setSettledKey] = useState(key);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A timer decides when a run of thread switches has stopped.
  useEffect(() => {
    if (settledKey === key) return;
    // Rendered synchronously so the view's queries subscribe in this task; a deferred render
    // leaves their fresh nodes unsubscribed long enough for the registry to collect them, which
    // interrupts the requests they just started and sends them again.
    const timer = window.setTimeout(() => flushSync(() => setSettledKey(key)), SIDE_AREA_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [key, settledKey]);
  return (
    <DeferEnvironmentQueries value={settledKey !== key}>
      <Fragment key={key === null ? definition.id : `${key}:${definition.id}`}>
        <HostedView
          definition={definition}
          target={target}
          layout={layout}
          host="panel"
          width={width}
          slots={slots}
          onOpenFullSize={() => useToolSidebarStore.getState().dispatch({ type: "close" })}
        />
      </Fragment>
    </DeferEnvironmentQueries>
  );
}

function ViewPicker({
  definition,
  target,
}: {
  definition: (typeof PANEL_VIEW_DEFINITIONS)[number];
  target: ViewTarget;
}) {
  const [open, setOpen] = useState(false);
  const drawerMounted = useMobileSidebarSheetMounted();
  const requests = useToolSidebarStore(sideAreaOpenRequests);
  const trigger = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The drawer releases modal focus before the picker takes it.
  useLayoutEffect(() => {
    if (!drawerMounted && takeSideAreaFocusRequest(requests))
      trigger.current?.focus({ preventScroll: true });
  }, [drawerMounted, requests]);
  const hidden = useToolSidebarStore((state) => state.hidden);
  const dispatch = useToolSidebarStore((state) => state.dispatch);
  const visibleViews = PANEL_VIEW_DEFINITIONS.filter((entry) => !hidden.includes(entry.id));
  const hiddenViews = PANEL_VIEW_DEFINITIONS.filter((entry) => hidden.includes(entry.id));
  const Icon = definition.icon;
  const groups = [
    { label: "This thread", views: visibleViews.filter((entry) => entry.scope === "thread") },
    { label: "Everywhere", views: visibleViews.filter((entry) => entry.scope === "global") },
  ];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        ref={trigger}
        data-side-area-picker
        render={
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0"
            aria-label={`View: ${definition.title}. Choose a view`}
          />
        }
      >
        <Icon />
        <span className="min-w-0 truncate">{definition.title}</span>
        <ChevronDownIcon className="opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-60">
        <MenuRadioGroup
          value={definition.id}
          onValueChange={(value) => {
            const next = PANEL_VIEW_DEFINITIONS.find((entry) => entry.id === value);
            if (next) dispatch({ type: "show", view: next.id });
          }}
        >
          {groups
            .filter((group) => group.views.length > 0)
            .map((group, index) => (
              <Fragment key={group.label}>
                {index > 0 ? <MenuSeparator /> : null}
                <MenuGroup>
                  <MenuGroupLabel>{group.label}</MenuGroupLabel>
                  {group.views.map((entry) => (
                    <Tooltip key={entry.id}>
                      <TooltipTrigger
                        render={
                          <MenuRadioItem
                            value={entry.id}
                            closeOnClick
                            aria-description={entry.about}
                          />
                        }
                      >
                        <span className="flex items-center gap-2">
                          <entry.icon className="text-muted-foreground" />
                          {entry.title}
                          {open && entry.PickerCount ? (
                            <DeferEnvironmentQueries value>
                              <entry.PickerCount target={target} />
                            </DeferEnvironmentQueries>
                          ) : null}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup side="right">{entry.about}</TooltipPopup>
                    </Tooltip>
                  ))}
                </MenuGroup>
              </Fragment>
            ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger>
            <EyeOffIcon aria-hidden />
            Hide a view
          </MenuSubTrigger>
          <MenuSubPopup>
            {visibleViews.map((entry) => {
              const disabled = !canHideView(entry.id, hidden);
              return (
                <MenuItem
                  key={entry.id}
                  disabled={disabled}
                  aria-description={
                    disabled ? "Keep at least one thread view in the picker." : undefined
                  }
                  onClick={() => dispatch({ type: "setHidden", view: entry.id, hidden: true })}
                >
                  <entry.icon aria-hidden />
                  Hide {entry.title}
                </MenuItem>
              );
            })}
          </MenuSubPopup>
        </MenuSub>
        {hiddenViews.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Hidden views</MenuGroupLabel>
              {hiddenViews.map((entry) => (
                <MenuItem
                  key={entry.id}
                  onClick={() => dispatch({ type: "setHidden", view: entry.id, hidden: false })}
                >
                  <entry.icon aria-hidden />
                  Show {entry.title}
                </MenuItem>
              ))}
            </MenuGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function ToolStatusDot({ state }: { state: "fail" | "warn" }) {
  return (
    <span className="pointer-events-none absolute -right-1 -top-1 flex rounded-full bg-sidebar p-px">
      <StatusSourceDot state={state} />
    </span>
  );
}
