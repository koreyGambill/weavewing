import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "../ui/dialog";
import { useTileResizeGesture } from "./useTileResizeGesture";
import {
  registerCommands,
  registerMenuAction,
  type CommandHandlers,
} from "../../shortcuts/dispatcher";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Check,
  Columns2,
  ArrowRightFromLine,
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Rows2,
  Maximize2,
  Minimize2,
  MessagesSquare,
  PictureInPicture2,
  Plus,
  SquareDashed,
  GripVertical,
  PanelRight,
  X,
} from "lucide-react";
import type {
  KeybindingCommand,
  ProjectId,
  SavedTileLayout,
  TileLayoutArea,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  useRightPanelStore,
  selectThreadTileLayout,
  type RightPanelSurface,
} from "../../rightPanelStore";
import {
  applyTileAction as reduceTileAction,
  CONVERSATION_TAB_ID,
  DEFAULT_FLOATING_TILE,
  firstFloatingTile,
  isNewTab,
  newTabId,
  getTileGroups,
  boundFloatingTile,
  resizeFloatingTile,
  clampTileWidths,
  tileMinimumWidth,
  TILE_MIN_WIDTH_PX,
  type FloatingTileEdges,
  type FloatingTileRect,
  type ThreadTileLayout,
  type TileAction,
  type TileGroup,
} from "../../threadTileLayout";
import {
  directionalTile,
  tileGeometry,
  tileDropOrder,
  type TileRect,
} from "../../threadTileGeometry";
import { shortcutLabelForCommand } from "../../keybindings";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useTheme } from "../../hooks/useTheme";
import { useThreadRelationshipShells, useThreadTitles } from "../../state/entities";
import { observeResize } from "../../lib/observeResize";
import { SurfaceIcon, surfaceTitle, type TileSurfaceActions } from "../SurfaceTabContent";
import type { TerminalMoveMenu } from "../terminal/useTerminalMoveMenus";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { cn, randomUUID } from "../../lib/utils";
import { ThreadPaneAttention } from "../ThreadAttentionOverlay";
import {
  dockedTiles,
  fitTileTabs,
  ownsTileInput,
  shownDockedRoot,
  splitTooNarrow,
  TILE_AREAS,
  TILE_CONTROL_PRIORITY,
  tileCloseConfirmation,
  tileDropZone,
  type TileAreaLabel,
  type TileEdgeZone,
  type TileControlKey,
  type TileTabFit,
} from "./ThreadTileWorkspace.logic";
import {
  savedTileGroupCount,
  TILE_LAYOUT_AREA_LABELS,
  tileLayoutAreaLabel,
  toSavedTileNode,
} from "../../savedTileLayouts";
import { WorkspaceTitlebarControls } from "../WorkspaceTitlebar";
import { SaveTileLayoutDialog, TileLayoutsMenu } from "./TileLayoutsMenu";
import { moveViewToSidePanel, placeDroppedView } from "./viewTileActions";
import { useViewDragStore } from "../../views/viewDragStore";
import { isViewArea, viewIdFromArea, viewSurface } from "../../views/viewTiles.logic";
import { useSavedTileLayouts } from "./useSavedTileLayouts";

const TAB_DRAG_TYPE = "application/x-weavewing-tab";
const GROUP_DRAG_TYPE = "application/x-weavewing-group";
type DropZone = "tabs" | "center" | "left" | "right" | "top" | "bottom";
type TileDrop = { groupId: string; zone: DropZone };
type TileDrag = { kind: "tab" | "group"; id: string };
type TileSplitAxis = "horizontal" | "vertical";
/** Dropping a tab or tile on another tile's edge splits that tile. */
const edgeDropAction = (
  drag: TileDrag,
  targetGroupId: string,
  zone: TileEdgeZone,
  ids: { groupId: string; splitId: string },
): TileAction => {
  const axis = zone === "left" || zone === "right" ? "horizontal" : "vertical";
  const side = zone === "left" || zone === "top" ? "before" : "after";
  return drag.kind === "group"
    ? { type: "dock-group", groupId: drag.id, targetGroupId, axis, side, splitId: ids.splitId }
    : { type: "split", tabId: drag.id, targetGroupId, axis, side, ...ids };
};
type PanelActions = TileSurfaceActions;
const rectStyle = (rect: TileRect): CSSProperties => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`,
  height: `${rect.height * 100}%`,
});
const pct = (value: number) => `${value * 100}%`;
const FLOAT_HANDLES: ReadonlyArray<{
  edges: FloatingTileEdges;
  cursor: string;
  style: (rect: FloatingTileRect) => CSSProperties;
}> = [
  {
    edges: { top: true },
    cursor: "cursor-ns-resize",
    style: (r) => ({
      left: pct(r.x),
      top: `calc(${pct(r.y)} - 3px)`,
      width: pct(r.width),
      height: 6,
    }),
  },
  {
    edges: { bottom: true },
    cursor: "cursor-ns-resize",
    style: (r) => ({
      left: pct(r.x),
      top: `calc(${pct(r.y + r.height)} - 3px)`,
      width: pct(r.width),
      height: 6,
    }),
  },
  {
    edges: { left: true },
    cursor: "cursor-ew-resize",
    style: (r) => ({
      left: `calc(${pct(r.x)} - 3px)`,
      top: pct(r.y),
      width: 6,
      height: pct(r.height),
    }),
  },
  {
    edges: { right: true },
    cursor: "cursor-ew-resize",
    style: (r) => ({
      left: `calc(${pct(r.x + r.width)} - 3px)`,
      top: pct(r.y),
      width: 6,
      height: pct(r.height),
    }),
  },
  {
    edges: { top: true, left: true },
    cursor: "cursor-nwse-resize",
    style: (r) => ({
      left: `calc(${pct(r.x)} - 5px)`,
      top: `calc(${pct(r.y)} - 5px)`,
      width: 10,
      height: 10,
    }),
  },
  {
    edges: { top: true, right: true },
    cursor: "cursor-nesw-resize",
    style: (r) => ({
      left: `calc(${pct(r.x + r.width)} - 5px)`,
      top: `calc(${pct(r.y)} - 5px)`,
      width: 10,
      height: 10,
    }),
  },
  {
    edges: { bottom: true, left: true },
    cursor: "cursor-nesw-resize",
    style: (r) => ({
      left: `calc(${pct(r.x)} - 5px)`,
      top: `calc(${pct(r.y + r.height)} - 5px)`,
      width: 10,
      height: 10,
    }),
  },
  {
    edges: { bottom: true, right: true },
    cursor: "cursor-nwse-resize",
    style: (r) => ({
      left: `calc(${pct(r.x + r.width)} - 14px)`,
      top: `calc(${pct(r.y + r.height)} - 14px)`,
      width: 16,
      height: 16,
    }),
  },
];

export function ThreadTileWorkspace(props: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId | null;
  /** Started by the user on this client and still without messages; takes the default layout once. */
  newThread: boolean;
  header: ReactNode;
  conversation: ReactNode;
  panels: PanelActions;
  runningTerminalIds: readonly string[];
  /** Closes surfaces without their own terminal prompt; the tile already asked. */
  onCloseTileSurfaces: (surfaces: readonly RightPanelSurface[]) => void;
  renderSurface: (
    surface: RightPanelSurface,
    visible: boolean,
    layoutVersion: string,
    focused: boolean,
  ) => ReactNode;
  /** Every tile is a terminal: new tiles and tabs open one at once, and saved layouts are hidden. */
  terminalsOnly?: boolean;
  /** Runs instead of the maximize command when there is only one tile to maximize. */
  onMaximizeOnlyTile?: () => void;
  /** Mounted over another workspace: takes tile keys and menu actions only while it holds focus. */
  overlay?: boolean;
}) {
  const compact = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const savedLayout = useRightPanelStore((state) =>
    selectThreadTileLayout(state.byThreadKey, props.threadRef),
  );
  const workspaceKey = `${props.threadRef.environmentId}:${props.threadRef.threadId}`;
  const focusHistory = useRef<{ key: string; ids: readonly string[] } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers focus changes from any input so navigation can resolve a shared divider
  useLayoutEffect(() => {
    const previous = focusHistory.current?.key === workspaceKey ? focusHistory.current.ids : [];
    const { focusedGroupId } = savedLayout;
    const groups = new Set(getTileGroups(savedLayout).map(({ id }) => id));
    focusHistory.current = {
      key: workspaceKey,
      ids: [focusedGroupId, ...previous.filter((id) => id !== focusedGroupId && groups.has(id))],
    };
  }, [savedLayout, workspaceKey]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the canvas so split minimums also hold after window resizing; measured before paint so saved ratios never flash at the minimum
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setWorkspaceWidth(root.clientWidth);
    return observeResize(root, () => setWorkspaceWidth(root.clientWidth));
  }, []);
  const tileLayouts = useSavedTileLayouts(props.threadRef.environmentId, props.projectId);
  const [saveLayout, setSaveLayout] = useState<
    (ReturnType<typeof toSavedTileNode> & { replaceId: string | null }) | null
  >(null);
  const defaultLayout = props.newThread ? tileLayouts.effectiveDefault : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lays out a new draft once the environment's settings name a default layout
  useEffect(() => {
    if (defaultLayout)
      useRightPanelStore.getState().applySavedTileLayout(props.threadRef, defaultLayout.root, true);
  }, [defaultLayout, props.threadRef]);
  const [localDrag, setDragging] = useState<TileDrag | null>(null);
  // A view dragged from the side panel drops like a tab; terminal-only workspaces take none.
  const viewDrag = useViewDragStore((state) => (props.terminalsOnly ? null : state.drag));
  const dragging: TileDrag | null =
    localDrag ??
    (viewDrag
      ? { kind: "tab", id: viewSurface(viewDrag.viewId, props.threadRef, viewDrag.thread).id }
      : null);
  const [dropTarget, setDropTarget] = useState<TileDrop | null>(null);
  const headerDragBlocked = useRef(false);
  const [resizing, setResizing] = useState(false);
  const [resizeOverride, setResizeOverride] = useState<{ splitId: string; ratio: number } | null>(
    null,
  );
  const [swapGroupId, setSwapGroupId] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<{ kind: "actions"; groupId: string } | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<{
    groupId: string;
    title: string;
    description: string | null;
  } | null>(null);
  const [chooserIndex, setChooserIndex] = useState<{ groupId: string; index: number } | null>(null);
  const gestureResize = useTileResizeGesture({
    rootRef,
    threadRef: props.threadRef,
    panels: props.panels,
    overlay: props.overlay === true,
  });
  const layout = gestureResize
    ? gestureResize.reduce(
        (current, change) =>
          reduceTileAction(
            current,
            change.splitId === "focus-pair-split"
              ? { type: "resize-focus-pair", ratio: change.ratio }
              : { type: "resize", ...change },
          ),
        savedLayout,
      )
    : resizeOverride
      ? reduceTileAction(
          savedLayout,
          resizeOverride.splitId === "focus-pair-split"
            ? { type: "resize-focus-pair", ratio: resizeOverride.ratio }
            : { type: "resize", ...resizeOverride },
        )
      : savedLayout;
  const { resolvedTheme } = useTheme();
  const groups = getTileGroups(layout);
  const maximized = layout.maximizedGroupId;
  const zoomedIds = new Set([maximized, layout.besideGroupId]);
  const displayRoot = shownDockedRoot(layout);
  const minimumWidth = compact
    ? 0
    : displayRoot
      ? tileMinimumWidth(displayRoot)
      : TILE_MIN_WIDTH_PX;
  const dockedRoot = displayRoot
    ? workspaceWidth > 0
      ? clampTileWidths(displayRoot, workspaceWidth)
      : displayRoot
    : null;
  const floatingGroups = compact
    ? []
    : groups.filter((group) => group.floating && !zoomedIds.has(group.id));
  const compactGroup = groups.find((group) => group.id === layout.focusedGroupId) ?? groups[0]!;
  const displayGroups = compact
    ? [compactGroup]
    : [...(dockedRoot ? getTileGroups(dockedRoot) : []), ...floatingGroups];
  const dockedGeometry = dockedRoot ? tileGeometry(dockedRoot) : { groups: [], splits: [] };
  const [floatingOverride, setFloatingOverride] = useState<{
    groupId: string;
    rect: FloatingTileRect;
  } | null>(null);
  const visibleGroups = compact
    ? [{ id: compactGroup.id, rect: { x: 0, y: 0, width: 1, height: 1 } }]
    : [
        ...dockedGeometry.groups,
        ...floatingGroups.map((group) => ({
          id: group.id,
          rect: boundFloatingTile({
            ...(floatingOverride?.groupId === group.id ? floatingOverride.rect : group.floating!),
            width: Math.max(
              (floatingOverride?.groupId === group.id ? floatingOverride.rect : group.floating!)
                .width,
              TILE_MIN_WIDTH_PX / Math.max(workspaceWidth, minimumWidth),
            ),
          }),
        })),
      ];
  const geometry = { groups: visibleGroups, splits: compact ? [] : dockedGeometry.splits };
  const dockedCount = groups.filter((group) => !group.floating).length;
  // A lone tile has nothing to be distinguished from.
  const focusedGroupId = visibleGroups.length > 1 ? layout.focusedGroupId : null;
  const visibleTabIds = displayGroups.map((group) => group.activeTabId);
  const [mountedTabIds, setMountedTabIds] = useState<string[]>([]);
  const validIds = new Set<string>(props.panels.surfaces.map((surface) => surface.id));
  const mounted = [
    ...new Set([
      ...mountedTabIds.filter((id) => validIds.has(id)),
      ...visibleTabIds.filter((id) => id && id !== CONVERSATION_TAB_ID),
    ]),
  ];
  if (
    mounted.length !== mountedTabIds.length ||
    mounted.some((id, index) => id !== mountedTabIds[index])
  )
    setMountedTabIds(mounted);
  const layoutVersion = JSON.stringify(layout);
  const currentLayout = () =>
    selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, props.threadRef);
  // Compact shows one tile at a time, so there is no pane width to keep.
  const tooNarrow = (current: ThreadTileLayout, action: TileAction) =>
    !compact && splitTooNarrow(current, action, workspaceWidth);
  const probeIds = { groupId: "split-probe", splitId: "split-probe-split" };
  const newTileTooNarrow = (current: ThreadTileLayout, groupId: string, axis: TileSplitAxis) =>
    tooNarrow(current, {
      type: "new-group",
      targetGroupId: groupId,
      axis,
      side: "after",
      ...probeIds,
    });
  const moveTabTooNarrow = (current: ThreadTileLayout, group: TileGroup, axis: TileSplitAxis) =>
    tooNarrow(current, {
      type: "split",
      tabId: group.activeTabId,
      targetGroupId: group.id,
      axis,
      side: "after",
      ...probeIds,
    });
  /** Applies a tile action; false when a split is refused for want of width. */
  const apply = (
    action: Parameters<ReturnType<typeof useRightPanelStore.getState>["applyTileAction"]>[1],
  ) => {
    if (tooNarrow(currentLayout(), action)) return false;
    useRightPanelStore
      .getState()
      .applyTileAction(
        props.threadRef,
        action.type === "resize" && action.splitId === "focus-pair-split"
          ? { type: "resize-focus-pair", ratio: action.ratio }
          : action,
      );
    return true;
  };
  const shortcut = (command: KeybindingCommand) =>
    shortcutLabelForCommand(props.panels.keybindings, command);
  const withShortcut = (label: string, command: KeybindingCommand) => {
    const keys = shortcut(command);
    return keys ? `${label} · ${keys}` : label;
  };
  // Side chats are this thread's children, so its relationship shells name their tabs.
  const relationshipShells = useThreadRelationshipShells(props.threadRef);
  const sideChatTitles = new Map(relationshipShells.map((shell) => [shell.id, shell.title]));
  const lockedViewTitles = useThreadTitles(
    props.panels.surfaces.flatMap((surface) =>
      surface.kind === "view" && surface.threadRef ? [surface.threadRef] : [],
    ),
  );
  const title = (id: string) => {
    if (id === CONVERSATION_TAB_ID) return "Main chat";
    if (isNewTab(id))
      return savedLayout.pendingAreas?.[id]
        ? (tileLayoutAreaLabel(savedLayout.pendingAreas[id]!) ?? "New tab")
        : "New tab";
    const surface = props.panels.surfaces.find((entry) => entry.id === id);
    return surface
      ? surfaceTitle(
          surface,
          props.panels.previewSessions,
          props.panels.terminalLabelsById,
          sideChatTitles,
          lockedViewTitles,
        )
      : "Choose an area";
  };
  const activate = (group: TileGroup, tabId: string) => {
    apply({ type: "activate", groupId: group.id, tabId });
    const surface = props.panels.surfaces.find((entry) => entry.id === tabId);
    if (surface) props.panels.onActivate(surface);
  };
  // Letter keys pick an area only while focus is out of the composer and other editors.
  const focusChooser = (groupId: string) =>
    requestAnimationFrame(() =>
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-tile-chooser="${CSS.escape(groupId)}"]`)
        ?.focus({ preventScroll: true }),
    );
  // The new tile or tab is focused, so an opened terminal takes its place.
  const fillNewTab = (groupId: string, sourceTabId?: string) =>
    props.terminalsOnly ? props.panels.onAddTerminal(sourceTabId) : focusChooser(groupId);
  const split = (
    group: TileGroup,
    axis: "horizontal" | "vertical",
    side: "before" | "after" = "after",
  ) => {
    const groupId = randomUUID();
    const added = apply({
      type: "new-group",
      targetGroupId: group.id,
      axis,
      side,
      groupId,
      splitId: randomUUID(),
    });
    if (added) fillNewTab(groupId, group.activeTabId);
  };
  const moveTabToNewTile = (group: TileGroup, axis: "horizontal" | "vertical") =>
    apply({
      type: "split",
      tabId: group.activeTabId,
      targetGroupId: group.id,
      axis,
      side: "after",
      groupId: randomUUID(),
      splitId: randomUUID(),
    });
  const canFloat = (group: TileGroup) =>
    Boolean(group.floating) ||
    getTileGroups(currentLayout()).filter((entry) => !entry.floating).length > 1;
  const anchoredFloat = (groupId: string) => {
    const root = dockedTiles(currentLayout().root);
    const docked = root && tileGeometry(root).groups.find((entry) => entry.id === groupId)?.rect;
    const workspace = rootRef.current;
    if (!docked || !workspace?.clientHeight) return DEFAULT_FLOATING_TILE;
    const bar = parseFloat(getComputedStyle(workspace).getPropertyValue("--tile-titlebar-height"));
    return firstFloatingTile(docked, (bar || 0) / workspace.clientHeight);
  };
  const toggleFloat = (group: TileGroup) => {
    if (!canFloat(group)) return;
    apply(
      group.floating
        ? { type: "restore-group", groupId: group.id }
        : {
            type: "float-group",
            groupId: group.id,
            rect: group.lastFloating ?? anchoredFloat(group.id),
          },
    );
  };
  const closeTileNow = (groupId: string) => {
    const group = getTileGroups(currentLayout()).find((entry) => entry.id === groupId);
    if (!group) return;
    const surfaces = props.panels.surfaces.filter((surface) => group.tabs.includes(surface.id));
    if (surfaces.length) props.onCloseTileSurfaces(surfaces);
    apply({ type: "close-group", groupId });
  };
  const closeTile = (groupId: string) => {
    const group = getTileGroups(currentLayout()).find((entry) => entry.id === groupId);
    if (!group) return;
    const confirmation = tileCloseConfirmation({
      tabIds: group.tabs,
      surfaces: props.panels.surfaces,
      runningTerminalIds: props.runningTerminalIds,
      terminalLabelsById: props.panels.terminalLabelsById,
    });
    if (confirmation) setCloseConfirm({ groupId, ...confirmation });
    else closeTileNow(groupId);
  };
  const closeTab = (tabId: string) => {
    const owner = getTileGroups(currentLayout()).find((group) => group.tabs.includes(tabId));
    // Only a close that removes the focused element moves focus; middle-clicking a background
    // tab leaves the user's caret where it is.
    const escaped = CSS.escape(tabId);
    const active = document.activeElement;
    const holdsFocus =
      active instanceof Element &&
      (active.closest(`[data-tile-content="${escaped}"]`) !== null ||
        active.closest(".workspace-tile-tab")?.querySelector(`[data-tab-id="${escaped}"]`) !=
          null ||
        (owner?.tabs.length === 1 &&
          active.closest(`[data-tile-group="${CSS.escape(owner.id)}"]`) !== null));
    if (owner && holdsFocus) parkFocus(owner.id);
    const surface = props.panels.surfaces.find((entry) => entry.id === tabId);
    if (surface) props.panels.onCloseSurface(surface);
    else apply({ type: "close-tab", tabId });
    if (!holdsFocus) return;
    const after = currentLayout();
    focus(
      owner && getTileGroups(after).some((group) => group.id === owner.id)
        ? owner.id
        : after.focusedGroupId,
    );
  };
  const openNewTab = (groupId: string) => {
    const source = getTileGroups(currentLayout()).find((group) => group.id === groupId);
    apply({ type: "new-tab", groupId, tabId: newTabId(randomUUID()) });
    fillNewTab(groupId, source?.activeTabId);
  };
  // A chooser unmounts once its area arrives or it closes. Focus left on it would drop to the
  // page, and workspace focus recovery would hand it to the composer, in another tile.
  const parkFocus = (groupId: string) =>
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-tile-group="${CSS.escape(groupId)}"]`)
      ?.focus({ preventScroll: true });
  const focus = (groupId: string) => {
    const group = getTileGroups(currentLayout()).find((entry) => entry.id === groupId);
    if (!group) return;
    if (isNewTab(group.activeTabId)) {
      apply({ type: "focus", groupId });
      focusChooser(groupId);
      return;
    }
    activate(group, group.activeTabId);
    const surface = props.panels.surfaces.find((entry) => entry.id === group.activeTabId);
    if (surface?.kind === "terminal") return;
    requestAnimationFrame(() => {
      const content = rootRef.current?.querySelector<HTMLElement>(
        `[data-tile-content="${CSS.escape(group.activeTabId)}"]`,
      );
      if (!content || content.contains(document.activeElement)) return;
      const target =
        group.activeTabId === CONVERSATION_TAB_ID || surface?.kind === "preview"
          ? (content.querySelector<HTMLElement>(
              '[contenteditable="true"], textarea, [role="textbox"]',
            ) ?? content)
          : content;
      target.focus({ preventScroll: true });
    });
  };
  const tabMenuItems = (group: TileGroup, tabIds: readonly string[]) =>
    tabIds.map((tabId) => {
      const surface = props.panels.surfaces.find((entry) => entry.id === tabId);
      return (
        <MenuItem key={tabId} onClick={() => activate(group, tabId)}>
          {surface ? (
            <SurfaceIcon
              surface={surface}
              previewUrl={null}
              previewCapturedUrl={null}
              theme={resolvedTheme}
              environmentId={props.threadRef.environmentId}
              pullRequestStatusSeed={undefined}
            />
          ) : isNewTab(tabId) ? (
            <SquareDashed />
          ) : (
            <MessagesSquare />
          )}
          <span className="min-w-0 flex-1 truncate">{title(tabId)}</span>
          {tabId === group.activeTabId && <Check aria-label="Active tab" />}
        </MenuItem>
      );
    });
  const panel = props.panels;
  const areaRuns: Record<TileAreaLabel, [boolean, (() => void) | undefined]> = {
    "Main chat": [true, undefined],
    Browser: [panel.browserAvailable, panel.onAddBrowser],
    Terminal: [panel.terminalAvailable, panel.onAddTerminal],
    Files: [panel.filesAvailable, panel.onAddFiles],
    Notes: [Boolean(panel.onAddNotes), panel.onAddNotes],
    Diff: [panel.diffAvailable, panel.onAddDiff],
    "Pull request": [panel.pullRequestAvailable, panel.onAddPullRequest],
    "Pull requests": [panel.pullRequestsAvailable, panel.onAddPullRequests],
    Device: [panel.deviceAvailable, panel.onAddDevice],
    "Side chat": [panel.sideChatAvailable === true, panel.onAddSideChat],
  };
  // A view area opens that view of this thread; one whose view no longer exists closes its tab.
  const pendingRun = (tabId: string, area: TileLayoutArea): [boolean, () => void] => {
    if (!isViewArea(area)) {
      const [enabled, run] = areaRuns[TILE_LAYOUT_AREA_LABELS[area]];
      return [enabled, () => run?.()];
    }
    const viewId = viewIdFromArea(area);
    return [
      true,
      viewId
        ? () => useRightPanelStore.getState().openView(props.threadRef, viewId, null)
        : () => apply({ type: "close-tab", tabId }),
    ];
  };
  const openablePending = Object.entries(savedLayout.pendingAreas ?? {}).filter(
    ([tabId, area]) => pendingRun(tabId, area)[0],
  );
  const requestedPending = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens a fresh surface for each saved-layout placeholder once its area becomes available
  useEffect(() => {
    for (const [tabId, area] of openablePending) {
      if (requestedPending.current.has(tabId)) continue;
      requestedPending.current.add(tabId);
      pendingRun(tabId, area)[1]();
    }
  });
  const chatGroup = groups.find((group) => group.tabs.includes(CONVERSATION_TAB_ID));
  const areaChoices: ReadonlyArray<{
    label: TileAreaLabel;
    key: string;
    enabled: boolean;
    /** Why the area can't open here; choosing it shows where it already is. */
    openElsewhere: string | null;
    run: (groupId: string) => void;
  }> = (() => {
    const runs = areaRuns;
    const areas = props.terminalsOnly
      ? TILE_AREAS.filter((area) => area.label === "Terminal")
      : TILE_AREAS;
    return areas.map(({ label, key }) => {
      const [enabled, run] = runs[label];
      return {
        label,
        key,
        enabled,
        openElsewhere:
          label === "Main chat" && chatGroup
            ? `Main chat is open in tile ${groups.indexOf(chatGroup) + 1}`
            : null,
        run: (groupId: string) => {
          if (label === "Main chat" && chatGroup) {
            activate(chatGroup, CONVERSATION_TAB_ID);
            focus(chatGroup.id);
            return;
          }
          if (!enabled) {
            const group = getTileGroups(currentLayout()).find((entry) => entry.id === groupId);
            const area = (
              Object.keys(TILE_LAYOUT_AREA_LABELS) as Array<keyof typeof TILE_LAYOUT_AREA_LABELS>
            ).find((area) => TILE_LAYOUT_AREA_LABELS[area] === label);
            if (group && area) apply({ type: "pending-area", tabId: group.activeTabId, area });
            return;
          }
          parkFocus(groupId);
          if (label === "Main chat")
            apply({ type: "move", tabId: CONVERSATION_TAB_ID, targetGroupId: groupId });
          else {
            apply({ type: "focus", groupId });
            run?.();
          }
          focus(groupId);
        },
      };
    });
  })();
  const firstOpenable = Math.max(
    0,
    areaChoices.findIndex((choice) => !choice.openElsewhere),
  );
  const saveLayoutAs = (replaceId: string | null = null) => {
    setSaveLayout({ ...toSavedTileNode(currentLayout()), replaceId });
  };
  const applySavedLayout = (layout: SavedTileLayout) => {
    useRightPanelStore.getState().applySavedTileLayout(props.threadRef, layout.root);
    focus(currentLayout().focusedGroupId);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers workspace commands, window keys and native browser menu actions for this mounted thread
  useEffect(() => {
    const currentGroup = () => {
      const current = currentLayout();
      return getTileGroups(current).find((entry) => entry.id === current.focusedGroupId);
    };
    const visibleGeometry = (restored = false) => {
      const current = currentLayout();
      const root = restored ? dockedTiles(current.root) : shownDockedRoot(current);
      return [
        ...(root ? tileGeometry(root).groups : []),
        ...getTileGroups(current)
          .filter(
            (group) =>
              group.floating &&
              (restored ||
                (group.id !== current.maximizedGroupId && group.id !== current.besideGroupId)),
          )
          .map((group) => ({ id: group.id, rect: group.floating! })),
      ];
    };
    const moveFocus = (direction: "left" | "right" | "up" | "down") => {
      const group = currentGroup();
      if (!group) return;
      const current = currentLayout();
      const recent = focusHistory.current?.ids;
      const findTarget = (restored = false) =>
        directionalTile(visibleGeometry(restored), group.id, direction, recent);
      // A pair moves within itself first; any other move from a maximized view restores the
      // layout and goes where the tiles sit there.
      const shown = current.besideGroupId ? findTarget() : null;
      if (shown || !current.maximizedGroupId) {
        const next = shown ?? findTarget();
        if (next) focus(next);
        return;
      }
      const next = findTarget(true);
      if (!next) return;
      apply({ type: "maximize", groupId: null });
      focus(next);
    };
    const focusNumberedTile = (index: number) => {
      const current = currentLayout();
      const group = getTileGroups(current)[index];
      if (!group) return;
      if (
        current.maximizedGroupId &&
        group.id !== current.focusedGroupId &&
        group.id !== current.maximizedGroupId &&
        (compact || !visibleGeometry().some((tile) => tile.id === group.id))
      ) {
        apply({ type: "maximize", groupId: null });
      }
      focus(group.id);
    };
    const newTile = (direction: "left" | "right" | "up" | "down") => {
      const group = currentGroup();
      if (!group) return;
      split(
        group,
        direction === "left" || direction === "right" ? "horizontal" : "vertical",
        direction === "left" || direction === "up" ? "before" : "after",
      );
    };
    const nextTab = (offset: number) => {
      const group = currentGroup();
      if (!group) return;
      // The hidden tab's content may hold focus; keep it in this tile, then move it to the new tab.
      parkFocus(group.id);
      activate(
        group,
        group.tabs[
          (group.tabs.indexOf(group.activeTabId) + offset + group.tabs.length) % group.tabs.length
        ]!,
      );
      focus(group.id);
    };
    const actions = {
      "workspace.tile.focusPair": () => {
        const current = currentLayout();
        if (current.besideGroupId) apply({ type: "maximize", groupId: null });
        else if (current.maximizedGroupId)
          setOpenMenu({ kind: "actions", groupId: current.maximizedGroupId });
        else apply({ type: "maximize", groupId: current.focusedGroupId });
      },
      "workspace.tile.rotate": () => apply({ type: "rotate" }),
      "workspace.tile.swap": () => {
        const current = currentLayout();
        if (current.besideGroupId) apply({ type: "swap-beside" });
        else setSwapGroupId(current.focusedGroupId);
      },
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          [`workspace.tile.focus.${index + 1}`, () => focusNumberedTile(index)] as const,
          [
            `workspace.tile.tab.${index + 1}`,
            () => {
              const group = currentGroup();
              const tab = group?.tabs[index];
              if (!group || !tab) return;
              parkFocus(group.id);
              activate(group, tab);
              focus(group.id);
            },
          ] as const,
        ]).flat(),
      ),
      "workspace.tile.float": () => {
        const group = currentGroup();
        if (group) toggleFloat(group);
      },
      "workspace.tile.newTab": () => {
        const group = currentGroup();
        if (group) openNewTab(group.id);
      },
      "workspace.tile.closeTab": () => {
        const group = currentGroup();
        if (group) closeTab(group.activeTabId);
      },
      "workspace.tile.closeAllTabs": () => {
        const group = currentGroup();
        if (group) closeTile(group.id);
      },
      "workspace.tile.actions": () => {
        const group = currentGroup();
        if (group) setOpenMenu({ kind: "actions", groupId: group.id });
      },
      "workspace.tile.focusLeft": () => moveFocus("left"),
      "workspace.tile.focusRight": () => moveFocus("right"),
      "workspace.tile.focusUp": () => moveFocus("up"),
      "workspace.tile.focusDown": () => moveFocus("down"),
      "workspace.tile.splitLeft": () => newTile("left"),
      "workspace.tile.splitRight": () => newTile("right"),
      "workspace.tile.splitUp": () => newTile("up"),
      "workspace.tile.splitDown": () => newTile("down"),
      "workspace.tile.maximize": () => {
        const current = currentLayout();
        if (props.onMaximizeOnlyTile && getTileGroups(current).length === 1) {
          props.onMaximizeOnlyTile();
          return;
        }
        apply({
          type: "maximize",
          groupId: current.maximizedGroupId ? null : current.focusedGroupId,
        });
      },
      "workspace.tile.previousTab": () => nextTab(-1),
      "workspace.tile.nextTab": () => nextTab(1),
    };
    const commands: CommandHandlers = Object.fromEntries(
      Object.entries(actions).map(([command, run]) => [
        command,
        (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();
          run();
        },
      ]),
    );
    const blockedTarget = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(
        target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [data-keybinding-capture]',
        ),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        blockedTarget(event.target) ||
        (event.target instanceof Element &&
          event.target.closest("[data-terminal-owner], .xterm")) ||
        document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')
      )
        return;
      const current = currentLayout();
      const group = getTileGroups(current).find((entry) => entry.id === current.focusedGroupId);
      const editing =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          /^(?:INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) ||
          event.target.closest('[role="textbox"]') !== null);
      // Enter and arrows belong to whatever control has focus; the chooser takes them only
      // from the page, its tile or its own box. Letters and Esc also work from its choices.
      const target = event.target instanceof Element ? event.target : null;
      const onChooser =
        event.target === document.body ||
        (target?.matches("[data-tile-group], [data-tile-chooser]") &&
          (target.getAttribute("data-tile-group") ?? target.getAttribute("data-tile-chooser")) ===
            group?.id);
      const inChooser =
        onChooser ||
        target?.closest("[data-tile-chooser]")?.getAttribute("data-tile-chooser") === group?.id;
      if (group && isNewTab(group.activeTabId) && !editing && inChooser) {
        const choices = areaChoices;
        const index = chooserIndex?.groupId === group.id ? chooserIndex.index : firstOpenable;
        const key = event.key.toLowerCase();
        const byKey = choices.find((choice) => choice.key === key);
        const step =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? -1
              : 0;
        if (byKey || event.key === "Escape" || (onChooser && (step || event.key === "Enter"))) {
          event.preventDefault();
          if (step) {
            // Arrows pass over areas already open elsewhere; their letter still finds them.
            let next = index;
            do next = (next + step + choices.length) % choices.length;
            while (choices[next]?.openElsewhere && next !== index);
            setChooserIndex({ groupId: group.id, index: next });
          } else if (event.key === "Escape") {
            parkFocus(group.id);
            apply({ type: "close-tab", tabId: group.activeTabId });
            focus(currentLayout().focusedGroupId);
          } else (byKey ?? choices[index])?.run(group.id);
          return;
        }
      }
      if (
        event.key === "Escape" &&
        current.maximizedGroupId &&
        !props.panels.getShortcutContext().terminalFocus
      ) {
        event.preventDefault();
        apply({ type: "maximize", groupId: null });
        focus(current.focusedGroupId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const disposers = [
      () => window.removeEventListener("keydown", onKeyDown),
      registerCommands(commands, {
        capture: true,
        keybindings: () => props.panels.keybindings,
        context: props.panels.getShortcutContext,
        when: (event) =>
          !gestureResize &&
          !event.isComposing &&
          !(
            event.target instanceof Element &&
            event.target.closest('[role="dialog"], [role="alertdialog"], [data-keybinding-capture]')
          ) &&
          ownsTileInput(rootRef.current, event.target, props.overlay === true),
      }),
      ...Object.entries(actions).map(([command, run]) =>
        registerMenuAction(command, () =>
          ownsTileInput(rootRef.current, document.activeElement, props.overlay === true)
            ? run()
            : false,
        ),
      ),
    ];
    for (const surface of props.panels.surfaces) {
      if (surface.kind !== "preview" || !surface.resourceId) continue;
      const nativeId = props.panels.previewRuntimeTabId?.(surface.resourceId) ?? surface.resourceId;
      disposers.push(
        registerMenuAction(`workspace.tile.browserFocused:${nativeId}`, () => {
          const owner = getTileGroups(currentLayout()).find((group) =>
            group.tabs.includes(surface.id),
          );
          if (owner) activate(owner, surface.id);
        }),
      );
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
  const runLayoutAction = useEffectEvent((kind: string, layoutId: string) => {
    const layout = tileLayouts.layouts.find((entry) => entry.id === layoutId);
    if (!layout) return;
    if (kind === "apply") applySavedLayout(layout);
    else if (kind === "projectDefault") tileLayouts.setProjectDefault(layout.id);
    else tileLayouts.setGlobalDefault(layout.id);
  });
  const saveLayoutFromMenu = useEffectEvent(() => saveLayoutAs());
  const layoutIds = tileLayouts.layouts.map((layout) => layout.id).join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the palette's saved-layout actions for this mounted thread
  useEffect(() => {
    if (props.terminalsOnly) return;
    const disposers = [
      registerMenuAction("workspace.tile.layout.save", () => saveLayoutFromMenu()),
      ...(layoutIds ? layoutIds.split("\n") : []).flatMap((layoutId) =>
        ["apply", "projectDefault", "globalDefault"].map((kind) =>
          registerMenuAction(`workspace.tile.layout.${kind}:${layoutId}`, () =>
            runLayoutAction(kind, layoutId),
          ),
        ),
      ),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [layoutIds, props.terminalsOnly]);

  const resize = (
    event: ReactPointerEvent<HTMLDivElement>,
    line: (typeof geometry.splits)[number],
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return;
    handle.setPointerCapture(event.pointerId);
    setResizing(true);
    let latestRatio = line.ratio;
    const move = (next: PointerEvent) => {
      const coordinate =
        line.axis === "horizontal"
          ? (next.clientX - bounds.left) / bounds.width
          : (next.clientY - bounds.top) / bounds.height;
      const start = line.axis === "horizontal" ? line.rect.x : line.rect.y;
      const size = line.axis === "horizontal" ? line.rect.width : line.rect.height;
      latestRatio = Math.max(0.12, Math.min(0.88, (coordinate - start) / size));
      setResizeOverride({ splitId: line.id, ratio: latestRatio });
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("lostpointercapture", stop);
      apply({ type: "resize", splitId: line.id, ratio: latestRatio });
      setResizeOverride(null);
      setResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop, { once: true });
    handle.addEventListener("lostpointercapture", stop, { once: true });
  };
  const locateDrop = (
    event: { clientX: number; clientY: number },
    excludedId?: string,
  ): TileDrop | null => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds || !bounds.width || !bounds.height) return null;
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const hovered = tileDropOrder(
      visibleGroups,
      floatingGroups.some((group) => group.id === layout.focusedGroupId)
        ? layout.focusedGroupId
        : null,
    ).find(
      ({ id, rect }) =>
        id !== excludedId &&
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height,
    );
    if (!hovered) return null;
    const localX = (x - hovered.rect.x) / hovered.rect.width;
    const localY = (y - hovered.rect.y) / hovered.rect.height;
    const titlebarHeight =
      Number.parseFloat(
        getComputedStyle(rootRef.current!).getPropertyValue("--tile-titlebar-height"),
      ) || 26;
    if ((y - hovered.rect.y) * bounds.height <= titlebarHeight)
      return { groupId: hovered.id, zone: "tabs" };
    const zone = tileDropZone(
      localX,
      localY,
      (edge) =>
        dragging !== null &&
        tooNarrow(currentLayout(), edgeDropAction(dragging, hovered.id, edge, probeIds)),
    );
    return zone ? { groupId: hovered.id, zone } : null;
  };
  // Floating tiles only move and resize; docking is an explicit button or menu choice.
  const floatGesture = (
    event: ReactPointerEvent<HTMLElement>,
    group: TileGroup,
    edges?: FloatingTileEdges,
  ) => {
    if (event.button !== 0 || !group.floating || zoomedIds.has(group.id)) return;
    if (
      !edges &&
      event.target instanceof Element &&
      event.target.closest("button, a, input, [role=tab]")
    )
      return;
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    apply({ type: "focus", groupId: group.id });
    const initial = geometry.groups.find((entry) => entry.id === group.id)?.rect ?? group.floating;
    let rect = initial;
    setResizing(true);
    const move = (next: PointerEvent) => {
      const delta = {
        x: (next.clientX - event.clientX) / bounds.width,
        y: (next.clientY - event.clientY) / bounds.height,
      };
      rect = edges
        ? resizeFloatingTile(initial, edges, delta, bounds.width)
        : boundFloatingTile({ ...initial, x: initial.x + delta.x, y: initial.y + delta.y });
      setFloatingOverride({ groupId: group.id, rect });
    };
    const stop = (next: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.removeEventListener("lostpointercapture", stop);
      const moved = (["x", "y", "width", "height"] as const).some(
        (key) => rect[key] !== initial[key],
      );
      if (next.type === "pointerup" && moved)
        apply({ type: "float-group", groupId: group.id, rect });
      setFloatingOverride(null);
      setResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop, { once: true });
    handle.addEventListener("pointercancel", stop, { once: true });
    handle.addEventListener("lostpointercapture", stop, { once: true });
  };
  const dropRect = dropTarget
    ? visibleGroups.find((group) => group.id === dropTarget.groupId)?.rect
    : undefined;
  const dropStyle: CSSProperties | undefined =
    dropRect && dropTarget
      ? {
          ...rectStyle({
            x: dropRect.x + (dropTarget.zone === "right" ? dropRect.width / 2 : 0),
            y: dropRect.y + (dropTarget.zone === "bottom" ? dropRect.height / 2 : 0),
            width:
              dropRect.width *
              (dropTarget.zone === "left" || dropTarget.zone === "right" ? 0.5 : 1),
            height:
              dropRect.height *
              (dropTarget.zone === "top" || dropTarget.zone === "bottom" ? 0.5 : 1),
          }),
          ...(dropTarget.zone === "tabs" ? { height: "var(--tile-titlebar-height)" } : {}),
        }
      : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-thread-tiling>
      {props.terminalsOnly ? null : (
        <WorkspaceTitlebarControls>
          <TileLayoutsMenu
            api={tileLayouts}
            hasProject={tileLayouts.projectId !== null}
            onSaveAs={() => saveLayoutAs()}
            onReplace={saveLayoutAs}
            onApply={applySavedLayout}
          />
        </WorkspaceTitlebarControls>
      )}
      <div className="relative shrink-0">{props.header}</div>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-auto">
        <div
          ref={rootRef}
          style={{ minWidth: minimumWidth }}
          className="relative isolate h-full min-h-0 min-w-0 overflow-hidden bg-border/40"
          onDragOverCapture={(event) => {
            if (!dragging) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            const next = locateDrop(event);
            setDropTarget((current) =>
              current?.groupId === next?.groupId && current?.zone === next?.zone ? current : next,
            );
          }}
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              setDropTarget(null);
          }}
          onDropCapture={(event) => {
            if (!dragging) return;
            event.preventDefault();
            event.stopPropagation();
            const target = locateDrop(event);
            const tabElement =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-tab-id]")
                : null;
            const drop = () => {
              if (!target) return;
              const { groupId: targetGroupId, zone } = target;
              if (zone !== "center" && zone !== "tabs")
                apply(
                  edgeDropAction(dragging, targetGroupId, zone, {
                    groupId: randomUUID(),
                    splitId: randomUUID(),
                  }),
                );
              else if (dragging.kind === "group") {
                if (zone === "tabs")
                  apply({ type: "merge-groups", groupId: dragging.id, targetGroupId });
                else
                  apply({
                    type: "swap-groups",
                    firstGroupId: dragging.id,
                    secondGroupId: targetGroupId,
                  });
              } else {
                const targetGroup = groups.find((group) => group.id === targetGroupId);
                const index = tabElement?.dataset.tabId
                  ? targetGroup?.tabs.indexOf(tabElement.dataset.tabId)
                  : undefined;
                apply({
                  type: "move",
                  tabId: dragging.id,
                  targetGroupId,
                  ...(index !== undefined ? { index } : {}),
                });
              }
            };
            if (localDrag === null && viewDrag) {
              if (target) placeDroppedView(props.threadRef, viewDrag, drop);
              else useViewDragStore.setState({ drag: null });
            } else drop();
            setDragging(null);
            setDropTarget(null);
          }}
        >
          {visibleGroups.map(({ id, rect }) => {
            const group = displayGroups.find((entry) => entry.id === id)!;
            const groupNumber = groups.findIndex((entry) => entry.id === id) + 1;
            const others = groups.filter((entry) => entry.id !== id);
            const chooserSelection =
              chooserIndex?.groupId === id ? chooserIndex.index : firstOpenable;
            const chooserActive = focusedGroupId === id || visibleGroups.length === 1;
            const activeSurface = props.panels.surfaces.find(
              (entry) => entry.id === group.activeTabId,
            );
            const moveMenu =
              activeSurface?.kind === "terminal"
                ? (props.panels.terminalMoveMenu?.(activeSurface.resourceId) ?? null)
                : null;
            const blank = group.tabs.every(isNewTab);
            // The only tile's only New tab has nothing to close into.
            const lastBlankTab = groups.length === 1 && group.tabs.length === 1 && blank;
            return (
              <section
                key={id}
                style={
                  {
                    ...rectStyle(rect),
                    zIndex: group.floating ? (layout.focusedGroupId === id ? 52 : 50) : undefined,
                    "--tile-group-accent": `var(--tile-accent-${group.colorIndex ?? 0})`,
                  } as CSSProperties
                }
                className={cn(
                  "workspace-tile-frame @container/tile absolute flex flex-col overflow-hidden bg-background outline-none",
                  group.floating && "shadow-2xl",
                )}
                data-focused={focusedGroupId === id}
                aria-label={`Tile: ${title(group.activeTabId)}`}
                data-tile-group={id}
                tabIndex={-1}
              >
                <FittedTileBar
                  tabIds={group.tabs}
                  activeTabId={group.activeTabId}
                  controls={compact ? COMPACT_TILE_CONTROLS : TILE_CONTROL_PRIORITY}
                >
                  {(fit, tabAreaRef) => {
                    const foldedTabs = group.tabs.filter((tabId) => !fit.shown.has(tabId));
                    return (
                      <div
                        className="workspace-tile-titlebar flex min-w-0 shrink-0 cursor-grab items-center justify-end gap-0.5 px-1 active:cursor-grabbing"
                        role="toolbar"
                        aria-label={`Move tile: ${title(group.activeTabId)}`}
                        draggable={!maximized && !group.floating}
                        onClickCapture={(event) => {
                          const button =
                            event.target instanceof Element
                              ? event.target.closest<HTMLElement>("button:not([role=tab])")
                              : null;
                          if (button) flashPress(button);
                        }}
                        onPointerDownCapture={(event) => {
                          headerDragBlocked.current =
                            event.target instanceof Element &&
                            Boolean(event.target.closest("button, a, input, [role=tab]"));
                        }}
                        onPointerDown={(event) => {
                          if (
                            event.target instanceof Element &&
                            event.target.closest('[role="menu"]')
                          )
                            return;
                          apply({ type: "focus", groupId: id });
                          floatGesture(event, group);
                        }}
                        onDragStart={(event) => {
                          if (maximized || headerDragBlocked.current) {
                            event.preventDefault();
                            return;
                          }
                          event.dataTransfer.setData(GROUP_DRAG_TYPE, id);
                          event.dataTransfer.effectAllowed = "move";
                          setDragging({ kind: "group", id });
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                      >
                        <GripVertical
                          aria-hidden
                          className="workspace-tile-grip size-3 shrink-0 max-[501px]:hidden"
                        />
                        <span
                          className="workspace-tile-grip shrink-0 text-2xs tabular-nums max-[501px]:hidden"
                          aria-label={`Group ${groupNumber}`}
                        >
                          {groupNumber}
                        </span>
                        <div
                          ref={tabAreaRef}
                          className="flex min-w-0 flex-1 items-center overflow-hidden"
                        >
                          <div
                            className="flex min-w-0 items-center px-1"
                            role="tablist"
                            aria-label="Tile tabs"
                          >
                            {group.tabs.map((tabId) => {
                              const tabFit = !fit.shown.has(tabId)
                                ? "folded"
                                : tabId === group.activeTabId
                                  ? fit.mode
                                  : "full";
                              const surface = props.panels.surfaces.find(
                                (entry) => entry.id === tabId,
                              );
                              const session =
                                surface?.kind === "preview" && surface.resourceId
                                  ? props.panels.previewSessions[surface.resourceId]
                                  : null;
                              const previewUrl =
                                session && session.navStatus._tag !== "Idle"
                                  ? session.navStatus.url
                                  : null;
                              return (
                                <div
                                  key={tabId}
                                  className={cn(
                                    "workspace-tile-tab flex max-w-44 items-center rounded-sm",
                                    tabFit === "folded"
                                      ? "pointer-events-none invisible absolute w-max"
                                      : tabFit === "truncated"
                                        ? "min-w-0 shrink"
                                        : "shrink-0",
                                  )}
                                  data-active={group.activeTabId === tabId}
                                  data-fit-tab={tabId}
                                  data-fit={tabFit}
                                >
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <button
                                          type="button"
                                          role="tab"
                                          data-tab-id={tabId}
                                          aria-selected={group.activeTabId === tabId}
                                          aria-label={title(tabId)}
                                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 px-1.5 py-0.5 text-2xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                                          draggable={!maximized}
                                          onDragStart={(event) => {
                                            event.stopPropagation();
                                            if (maximized) {
                                              event.preventDefault();
                                              return;
                                            }
                                            event.dataTransfer.setData(TAB_DRAG_TYPE, tabId);
                                            event.dataTransfer.effectAllowed = "move";
                                            setDragging({ kind: "tab", id: tabId });
                                          }}
                                          onDragEnd={() => {
                                            setDragging(null);
                                            setDropTarget(null);
                                          }}
                                          onMouseDown={(event) => {
                                            if (event.button === 1) event.preventDefault();
                                          }}
                                          onAuxClick={(event) => {
                                            if (event.button !== 1) return;
                                            event.preventDefault();
                                            event.stopPropagation();
                                            closeTab(tabId);
                                          }}
                                          onClick={() => activate(group, tabId)}
                                        />
                                      }
                                    >
                                      {surface ? (
                                        <SurfaceIcon
                                          surface={surface}
                                          previewUrl={previewUrl}
                                          previewCapturedUrl={null}
                                          theme={resolvedTheme}
                                          environmentId={props.threadRef.environmentId}
                                          pullRequestStatusSeed={undefined}
                                        />
                                      ) : isNewTab(tabId) ? (
                                        <SquareDashed className="size-3 shrink-0" />
                                      ) : (
                                        <MessagesSquare className="size-3 shrink-0" />
                                      )}
                                      <span
                                        data-fit-label
                                        className={cn(
                                          "min-w-0 truncate",
                                          tabFit === "icon" && "hidden",
                                        )}
                                      >
                                        {title(tabId)}
                                      </span>
                                      <span
                                        aria-hidden
                                        data-fit-title
                                        className="pointer-events-none invisible absolute w-max"
                                      >
                                        {title(tabId)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipPopup>{title(tabId)}</TooltipPopup>
                                  </Tooltip>
                                  {!lastBlankTab && (
                                    <PanelTabCloseButton
                                      label={`Close ${title(tabId)}`}
                                      onClick={() => closeTab(tabId)}
                                    >
                                      <X className="size-3" />
                                    </PanelTabCloseButton>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <span
                            data-fit-chip
                            className={cn(
                              "shrink-0",
                              foldedTabs.length === 0 && "invisible absolute",
                            )}
                          >
                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button
                                    size="micro"
                                    variant="ghost"
                                    aria-label={`${foldedTabs.length} more ${foldedTabs.length === 1 ? "tab" : "tabs"}`}
                                  />
                                }
                              >
                                {/* As wide as +99 whatever the count, so the fold count depends on width alone. */}
                                <span className="grid tabular-nums">
                                  <span className="invisible col-start-1 row-start-1">+99</span>
                                  <span className="col-start-1 row-start-1 text-center">
                                    +{Math.max(1, foldedTabs.length)}
                                  </span>
                                </span>
                              </MenuTrigger>
                              <MenuPopup align="start">{tabMenuItems(group, foldedTabs)}</MenuPopup>
                            </Menu>
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-micro"
                                  variant="ghost"
                                  aria-label="New tab"
                                  data-fit-new-tab
                                  onClick={() => openNewTab(id)}
                                />
                              }
                            >
                              <Plus className="size-3" />
                            </TooltipTrigger>
                            <TooltipPopup>
                              {withShortcut("New tab", "workspace.tile.newTab")}
                            </TooltipPopup>
                          </Tooltip>
                        </div>
                        {compact && groups.length > 1 ? (
                          <div className="flex shrink-0 items-center">
                            <span className="max-[501px]:hidden">
                              <TileControl
                                label="Previous tile"
                                onClick={() =>
                                  focus(
                                    groups[(groupNumber + groups.length - 2) % groups.length]!.id,
                                  )
                                }
                              >
                                <ChevronLeft />
                              </TileControl>
                            </span>
                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button size="micro" variant="ghost" aria-label="Switch tile" />
                                }
                              >
                                {groupNumber}/{groups.length}
                              </MenuTrigger>
                              <MenuPopup align="end">
                                {groups.map((entry, index) => (
                                  <MenuItem key={entry.id} onClick={() => focus(entry.id)}>
                                    {index + 1}: {title(entry.activeTabId)}
                                  </MenuItem>
                                ))}
                              </MenuPopup>
                            </Menu>
                            <span className="max-[501px]:hidden">
                              <TileControl
                                label="Next tile"
                                onClick={() => focus(groups[groupNumber % groups.length]!.id)}
                              >
                                <ChevronRight />
                              </TileControl>
                            </span>
                          </div>
                        ) : null}
                        <TileControl
                          menuOnly={compact}
                          fit="split"
                          hidden={fit.hiddenControls.has("split")}
                          label="New tile to the right"
                          disabled={newTileTooNarrow(layout, id, "horizontal")}
                          shortcut={shortcut("workspace.tile.splitRight")}
                          onClick={() => split(group, "horizontal")}
                        >
                          <Columns2 />
                        </TileControl>
                        <TileControl
                          menuOnly={compact}
                          fit="split"
                          hidden={fit.hiddenControls.has("split")}
                          label="New tile below"
                          disabled={newTileTooNarrow(layout, id, "vertical")}
                          shortcut={shortcut("workspace.tile.splitDown")}
                          onClick={() => split(group, "vertical")}
                        >
                          <Rows2 />
                        </TileControl>
                        {!compact ? (
                          <>
                            <TileControl
                              fit="float"
                              hidden={fit.hiddenControls.has("float")}
                              label={group.floating ? "Dock tile" : "Float tile"}
                              shortcut={shortcut("workspace.tile.float")}
                              pressed={Boolean(group.floating)}
                              disabled={(!group.floating && dockedCount < 2) || zoomedIds.has(id)}
                              onClick={() => toggleFloat(group)}
                            >
                              <PictureInPicture2 />
                            </TileControl>
                            <TileControl
                              fit="maximize"
                              hidden={fit.hiddenControls.has("maximize")}
                              label={zoomedIds.has(id) ? "Restore tiles" : "Maximize tile"}
                              shortcut={shortcut("workspace.tile.maximize")}
                              pressed={zoomedIds.has(id)}
                              onClick={() =>
                                apply({ type: "maximize", groupId: zoomedIds.has(id) ? null : id })
                              }
                            >
                              {zoomedIds.has(id) ? <Minimize2 /> : <Maximize2 />}
                            </TileControl>
                          </>
                        ) : null}
                        <Menu
                          open={openMenu?.kind === "actions" && openMenu.groupId === id}
                          onOpenChange={(open) =>
                            setOpenMenu(open ? { kind: "actions", groupId: id } : null)
                          }
                        >
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <MenuTrigger
                                  render={
                                    <Button
                                      size="icon-micro"
                                      variant="ghost"
                                      aria-label="Tile actions"
                                      data-fit-menu
                                    />
                                  }
                                />
                              }
                            >
                              <Ellipsis className="size-3" />
                            </TooltipTrigger>
                            <TooltipPopup>
                              {withShortcut("Tile actions", "workspace.tile.actions")}
                            </TooltipPopup>
                          </Tooltip>
                          <MenuPopup align="end">
                            {!compact ? (
                              <>
                                <MenuItem
                                  onClick={() =>
                                    apply({
                                      type: "maximize",
                                      groupId: zoomedIds.has(id) ? null : id,
                                    })
                                  }
                                >
                                  {zoomedIds.has(id) ? <Minimize2 /> : <Maximize2 />}
                                  {zoomedIds.has(id) ? "Restore tiles" : "Maximize tile"}
                                  <TileMenuShortcut keys={shortcut("workspace.tile.maximize")} />
                                </MenuItem>
                                <MenuItem
                                  disabled={
                                    (!group.floating && dockedCount < 2) || zoomedIds.has(id)
                                  }
                                  onClick={() => toggleFloat(group)}
                                >
                                  <PictureInPicture2 />
                                  {group.floating ? "Dock tile" : "Float tile"}
                                  <TileMenuShortcut keys={shortcut("workspace.tile.float")} />
                                </MenuItem>
                              </>
                            ) : null}
                            <MenuItem
                              disabled={newTileTooNarrow(layout, id, "vertical")}
                              onClick={() => split(group, "vertical")}
                            >
                              <Rows2 />
                              New tile below
                              <TileMenuShortcut keys={shortcut("workspace.tile.splitDown")} />
                            </MenuItem>
                            <MenuItem
                              disabled={newTileTooNarrow(layout, id, "horizontal")}
                              onClick={() => split(group, "horizontal")}
                            >
                              <Columns2 />
                              New tile to the right
                              <TileMenuShortcut keys={shortcut("workspace.tile.splitRight")} />
                            </MenuItem>
                            <MenuItem onClick={() => openNewTab(id)}>
                              <Plus />
                              New tab
                              <TileMenuShortcut keys={shortcut("workspace.tile.newTab")} />
                            </MenuItem>
                            {group.tabs.length > 1 && (
                              <MenuSub>
                                <MenuSubTrigger>
                                  <MessagesSquare />
                                  Switch tab
                                </MenuSubTrigger>
                                <MenuSubPopup>{tabMenuItems(group, group.tabs)}</MenuSubPopup>
                              </MenuSub>
                            )}
                            {maximized === id && others.length > 0 && (
                              <MenuGroup>
                                <MenuGroupLabel>Show beside…</MenuGroupLabel>
                                {others.map((entry) => (
                                  <MenuItem
                                    key={entry.id}
                                    onClick={() =>
                                      apply({ type: "show-beside", groupId: entry.id })
                                    }
                                  >
                                    <span
                                      className="size-2 shrink-0 rounded-full"
                                      style={{
                                        background: `var(--tile-accent-${entry.colorIndex ?? 0})`,
                                      }}
                                    />
                                    {groups.indexOf(entry) + 1}. {title(entry.activeTabId)}
                                  </MenuItem>
                                ))}
                                <MenuSeparator />
                              </MenuGroup>
                            )}
                            {layout.besideGroupId && zoomedIds.has(id) && (
                              <MenuItem onClick={() => apply({ type: "swap-beside" })}>
                                <ArrowRightLeft />
                                Swap sides
                                <TileMenuShortcut keys={shortcut("workspace.tile.swap")} />
                              </MenuItem>
                            )}
                            <MenuSub>
                              <MenuSubTrigger disabled={others.length === 0}>
                                <ArrowRightLeft />
                                Move tab
                              </MenuSubTrigger>
                              <MenuSubPopup>
                                {others.map((entry) => (
                                  <MenuItem
                                    key={entry.id}
                                    onClick={() =>
                                      apply({
                                        type: "move",
                                        tabId: group.activeTabId,
                                        targetGroupId: entry.id,
                                      })
                                    }
                                  >
                                    <span
                                      className="size-2 shrink-0 rounded-full"
                                      style={{
                                        background: `var(--tile-accent-${entry.colorIndex ?? 0})`,
                                      }}
                                    />
                                    {groups.indexOf(entry) + 1}. {title(entry.activeTabId)}
                                  </MenuItem>
                                ))}
                              </MenuSubPopup>
                            </MenuSub>
                            <MenuSub>
                              <MenuSubTrigger disabled={group.tabs.length < 2}>
                                <Columns2 />
                                Move tab to new tile
                              </MenuSubTrigger>
                              <MenuSubPopup>
                                <MenuItem
                                  disabled={moveTabTooNarrow(layout, group, "horizontal")}
                                  onClick={() => moveTabToNewTile(group, "horizontal")}
                                >
                                  <Columns2 />
                                  Right
                                </MenuItem>
                                <MenuItem
                                  disabled={moveTabTooNarrow(layout, group, "vertical")}
                                  onClick={() => moveTabToNewTile(group, "vertical")}
                                >
                                  <Rows2 />
                                  Below
                                </MenuItem>
                              </MenuSubPopup>
                            </MenuSub>
                            {moveMenu ? <TerminalMoveMenuItem menu={moveMenu} /> : null}
                            {activeSurface?.kind === "view" ? (
                              <MenuItem
                                onClick={() => moveViewToSidePanel(props.threadRef, activeSurface)}
                              >
                                <PanelRight />
                                Move to side panel
                              </MenuItem>
                            ) : null}
                            <MenuSeparator />
                            <MenuItem
                              disabled={lastBlankTab}
                              onClick={() => closeTab(group.activeTabId)}
                            >
                              <X />
                              Close tab
                              <TileMenuShortcut keys={shortcut("workspace.tile.closeTab")} />
                            </MenuItem>
                            <MenuItem
                              disabled={groups.length === 1 && blank}
                              onClick={() => closeTile(id)}
                            >
                              <X />
                              Close all tabs in tile
                              <TileMenuShortcut keys={shortcut("workspace.tile.closeAllTabs")} />
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                        <TileControl
                          fit="close"
                          hidden={fit.hiddenControls.has("close")}
                          label={blank ? "Close empty tile" : "Close tile"}
                          disabled={groups.length === 1 && blank}
                          onClick={() => closeTile(id)}
                        >
                          <X />
                        </TileControl>
                      </div>
                    );
                  }}
                </FittedTileBar>
                {isNewTab(group.activeTabId) && (
                  <div
                    className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 py-3 outline-none @max-[20rem]/tile:px-2"
                    data-tile-chooser={id}
                    aria-keyshortcuts={areaChoices
                      .map((choice) => choice.key.toUpperCase())
                      .join(" ")}
                    tabIndex={-1}
                    onPointerDown={(event) => {
                      apply({ type: "focus", groupId: id });
                      if (!(event.target instanceof Element && event.target.closest("button")))
                        event.currentTarget.focus({ preventScroll: true });
                      floatGesture(event, group);
                    }}
                  >
                    <div className="my-auto flex shrink-0 flex-col items-center gap-3">
                      <p className="text-sm font-medium">
                        {savedLayout.pendingAreas?.[group.activeTabId]
                          ? tileLayoutAreaLabel(savedLayout.pendingAreas[group.activeTabId]!)
                          : "Choose an area"}
                      </p>
                      {savedLayout.pendingAreas?.[group.activeTabId] && (
                        <p className="-mt-2 text-xs text-muted-foreground">
                          {savedLayout.pendingAreas[group.activeTabId] === "diff"
                            ? "No changes to diff yet. This tile will update when changes are available."
                            : `${tileLayoutAreaLabel(savedLayout.pendingAreas[group.activeTabId]!)} will open automatically when this thread is ready.`}
                        </p>
                      )}
                      <div
                        className="flex w-full max-w-md flex-wrap justify-center gap-2 @max-[20rem]/tile:grid @max-[20rem]/tile:grid-cols-1 @max-[20rem]/tile:gap-1"
                        role="group"
                        aria-label="Areas"
                      >
                        {areaChoices.map((choice, index) => {
                          const openNote =
                            choice.openElsewhere && chatGroup?.id === id
                              ? "Main chat is open in this tile"
                              : choice.openElsewhere;
                          const button = (
                            <Button
                              key={choice.label}
                              variant={
                                chooserActive && index === chooserSelection ? "default" : "outline"
                              }
                              size="sm"
                              className="@max-[20rem]/tile:justify-between"
                              aria-keyshortcuts={choice.key.toUpperCase()}
                              aria-disabled={choice.openElsewhere ? true : undefined}
                              aria-description={openNote ?? undefined}
                              onClick={() => choice.run(id)}
                            >
                              {choice.label}
                              <Kbd
                                aria-hidden
                                variant={
                                  chooserActive && index === chooserSelection
                                    ? "primary"
                                    : "default"
                                }
                              >
                                {choice.key.toUpperCase()}
                              </Kbd>
                            </Button>
                          );
                          return choice.openElsewhere ? (
                            <Tooltip key={choice.label}>
                              <TooltipTrigger render={button} />
                              <TooltipPopup>{openNote}</TooltipPopup>
                            </Tooltip>
                          ) : (
                            button
                          );
                        })}
                      </div>
                      <p className="text-center text-xs text-muted-foreground @max-[20rem]/tile:hidden">
                        Press a letter, or use the arrows and Enter.
                        {lastBlankTab
                          ? ""
                          : group.tabs.length > 1
                            ? " Esc closes this tab."
                            : " Esc closes this tile."}
                      </p>
                    </div>
                  </div>
                )}
              </section>
            );
          })}
          {floatingGroups.flatMap((group) => {
            const rect =
              floatingOverride?.groupId === group.id ? floatingOverride.rect : group.floating!;
            const z = layout.focusedGroupId === group.id ? 54 : 52;
            return FLOAT_HANDLES.map((handle) => {
              const corner = handle.edges.bottom && handle.edges.right;
              return (
                <div
                  key={`resize-${group.id}-${Object.keys(handle.edges).join("-")}`}
                  role="separator"
                  aria-label={`Resize floating ${title(group.activeTabId)} ${Object.keys(handle.edges).join(" ")}`}
                  className={cn("absolute touch-none", handle.cursor)}
                  style={{ ...handle.style(rect), zIndex: z }}
                  onPointerDown={(event) => floatGesture(event, group, handle.edges)}
                >
                  {corner && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute right-1 bottom-1 size-2.5 border-r-2 border-b-2 border-foreground/50"
                    />
                  )}
                </div>
              );
            });
          })}
          {[
            CONVERSATION_TAB_ID,
            ...props.panels.surfaces
              .filter((surface) => mounted.includes(surface.id))
              .map((surface) => surface.id),
          ].map((tabId) => {
            const group = displayGroups.find((entry) => entry.tabs.includes(tabId));
            const placed = visibleGroups.find((entry) => entry.id === group?.id);
            const visible = Boolean(placed && group?.activeTabId === tabId);
            const rect = placed?.rect ?? { x: 0, y: 0, width: 1, height: 1 };
            const surface = props.panels.surfaces.find((entry) => entry.id === tabId);
            const contentVisible =
              visible &&
              !(
                surface?.kind === "preview" &&
                (dragging !== null || resizing || gestureResize !== null)
              );
            return (
              <div
                key={tabId}
                data-tile-content={tabId}
                data-focused={focusedGroupId === group?.id}
                tabIndex={-1}
                inert={!visible}
                className="workspace-tile-content absolute z-10 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background outline-none"
                hidden={!visible}
                style={{
                  ...rectStyle(rect),
                  zIndex: group?.floating
                    ? layout.focusedGroupId === group.id
                      ? 53
                      : 51
                    : undefined,
                  left: `calc(${rect.x * 100}% + var(--tile-border-width))`,
                  width: `calc(${rect.width * 100}% - 2 * var(--tile-border-width))`,
                  top: `calc(${rect.y * 100}% + var(--tile-titlebar-height))`,
                  height: `calc(${rect.height * 100}% - var(--tile-titlebar-height) - var(--tile-border-width))`,
                  display: visible ? undefined : "none",
                }}
                onFocusCapture={() => {
                  if (group && layout.focusedGroupId !== group.id) activate(group, tabId);
                }}
                onPointerDownCapture={() => {
                  if (group && layout.focusedGroupId !== group.id) activate(group, tabId);
                }}
              >
                {visible && (tabId === CONVERSATION_TAB_ID || surface?.kind === "side-chat") && (
                  <ThreadPaneAttention
                    threadRef={
                      surface?.kind === "side-chat"
                        ? { ...props.threadRef, threadId: surface.threadId }
                        : props.threadRef
                    }
                  />
                )}
                {tabId === CONVERSATION_TAB_ID
                  ? props.conversation
                  : surface
                    ? props.renderSurface(
                        surface,
                        contentVisible,
                        layoutVersion,
                        layout.focusedGroupId === group?.id,
                      )
                    : null}
              </div>
            );
          })}
          {geometry.splits.map((line) => (
            <div
              key={line.id}
              role="separator"
              tabIndex={0}
              aria-label={`Resize ${line.axis === "horizontal" ? "columns" : "rows"}`}
              aria-orientation={line.axis === "horizontal" ? "vertical" : "horizontal"}
              aria-valuenow={Math.round(line.ratio * 100)}
              className={cn(
                "absolute z-40 touch-none bg-transparent hover:bg-ring/40 focus-visible:bg-ring/40",
                line.axis === "horizontal"
                  ? "w-1 -translate-x-1/2 cursor-col-resize"
                  : "h-1 -translate-y-1/2 cursor-row-resize",
                gestureResize?.some((change) => change.splitId === line.id) && "bg-ring",
              )}
              style={
                line.axis === "horizontal"
                  ? {
                      left: `${(line.rect.x + line.rect.width * line.ratio) * 100}%`,
                      top: `${line.rect.y * 100}%`,
                      height: `${line.rect.height * 100}%`,
                    }
                  : {
                      top: `${(line.rect.y + line.rect.height * line.ratio) * 100}%`,
                      left: `${line.rect.x * 100}%`,
                      width: `${line.rect.width * 100}%`,
                    }
              }
              onPointerDown={(event) => resize(event, line)}
              onKeyDown={(event) => {
                const offset =
                  event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -0.05
                    : event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 0.05
                      : 0;
                if (offset) {
                  event.preventDefault();
                  apply({
                    type: "resize",
                    splitId: line.id,
                    ratio: Math.max(0.12, Math.min(0.88, line.ratio + offset)),
                  });
                }
              }}
            />
          ))}
          {gestureResize && (
            <div
              className="fixed inset-0 z-50 cursor-move touch-none select-none"
              data-tile-resize-overlay
              aria-label="Resizing focused tile"
              role="status"
            >
              <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-ring bg-popover px-3 py-1 text-xs text-popover-foreground">
                Resize · H/J/K/L or arrows · Enter to keep · Esc to cancel
              </span>
            </div>
          )}
          {dragging && dropTarget && dropStyle && (
            <div
              className="pointer-events-none absolute z-[60] rounded-sm border-2 border-ring bg-ring/15"
              style={dropStyle}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
      <Dialog
        open={swapGroupId !== null}
        onOpenChange={(open) => {
          if (!open) setSwapGroupId(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Swap tile with…</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {groups
              .filter((group) => group.id !== swapGroupId)
              .map((group) => (
                <Button
                  key={group.id}
                  variant="outline"
                  onClick={() => {
                    if (swapGroupId)
                      apply({
                        type: "swap-groups",
                        firstGroupId: swapGroupId,
                        secondGroupId: group.id,
                      });
                    setSwapGroupId(null);
                  }}
                >
                  {groups.indexOf(group) + 1}. {title(group.activeTabId)}
                </Button>
              ))}
            {groups.length < 2 ? <p>No other tiles to swap.</p> : null}
          </div>
        </DialogPopup>
      </Dialog>
      {saveLayout && (
        <SaveTileLayoutDialog
          open
          onOpenChange={(open) => {
            if (!open) setSaveLayout(null);
          }}
          layouts={tileLayouts.layouts}
          replaceId={saveLayout.replaceId}
          dropped={saveLayout.dropped}
          tiles={saveLayout.root ? savedTileGroupCount(saveLayout.root) : 0}
          onSave={(name) => {
            const { root, replaceId } = saveLayout;
            if (root) tileLayouts.save(name, root, replaceId);
          }}
        />
      )}
      <AlertDialog
        open={closeConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setCloseConfirm(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{closeConfirm?.title}</AlertDialogTitle>
            {closeConfirm?.description ? (
              <AlertDialogDescription>{closeConfirm.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (closeConfirm) closeTileNow(closeConfirm.groupId);
                setCloseConfirm(null);
              }}
            >
              Close tile
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

const COMPACT_TILE_CONTROLS: readonly TileControlKey[] = ["close"];
// The lone active tab keeps its title down to this width before it shows its icon alone.
const TRUNCATED_TAB_PX = 96;

type TileBarFit = {
  shown: ReadonlySet<string>;
  mode: TileTabFit["mode"];
  hiddenControls: ReadonlySet<TileControlKey>;
};

/**
 * Fits a tile header's tabs and controls to its width. Titles are measured off-flow and only when
 * they resize, so dragging a split re-renders the header only when what fits changes.
 */
function FittedTileBar(props: {
  tabIds: readonly string[];
  activeTabId: string;
  controls: readonly TileControlKey[];
  children: (fit: TileBarFit, tabAreaRef: (element: HTMLDivElement | null) => void) => ReactNode;
}) {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  // Width of a tab around its title, kept from when the title last showed.
  const chrome = useRef(new Map<string, number>());
  const [fit, setFit] = useState<TileBarFit>(() => ({
    shown: new Set(props.tabIds),
    mode: "full",
    hiddenControls: new Set(),
  }));
  const tabKey = props.tabIds.join("\n");
  const controlKey = props.controls.join(" ");
  const { activeTabId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fits tabs to the measured header before paint, so no frame shows them overflowing
  useLayoutEffect(() => {
    const list = area?.querySelector<HTMLElement>('[role="tablist"]');
    const bar = area?.parentElement;
    if (!area || !list || !bar) return;
    const tabIds = tabKey ? tabKey.split("\n") : [];
    const controls = (controlKey ? controlKey.split(" ") : []) as TileControlKey[];
    const gap = Number.parseFloat(getComputedStyle(bar).columnGap) || 0;
    const listStyle = getComputedStyle(list);
    const listPadding =
      (Number.parseFloat(listStyle.paddingLeft) || 0) +
      (Number.parseFloat(listStyle.paddingRight) || 0);
    const tabs = [...list.querySelectorAll<HTMLElement>(":scope > [data-fit-tab]")];
    const titles = tabs.map((tab) => tab.querySelector<HTMLElement>("[data-fit-title]")!);
    const maxTab = tabs[0] ? Number.parseFloat(getComputedStyle(tabs[0]).maxWidth) : Infinity;
    const chip = area.querySelector<HTMLElement>("[data-fit-chip]");
    const newTab = area.querySelector<HTMLElement>("[data-fit-new-tab]");
    const width = (element: Element) => element.getBoundingClientRect().width;
    const naturalWidth = (tab: HTMLElement, index: number) => {
      const label = tab.querySelector<HTMLElement>("[data-fit-label]");
      if (tab.dataset.fit !== "icon" && label)
        chrome.current.set(tab.dataset.fitTab!, width(tab) - width(label));
      return Math.min(
        maxTab,
        (chrome.current.get(tab.dataset.fitTab!) ?? 0) + width(titles[index]!),
      );
    };
    const update = () => {
      const controlElements = [...bar.querySelectorAll<HTMLElement>("[data-fit-control]")];
      const widthOf = (elements: readonly HTMLElement[]) =>
        elements.reduce((total, element) => total + width(element) + gap, 0);
      const next = fitTileTabs({
        // The tab area takes what the bar leaves, so adding back the shown controls gives the
        // room with every control hidden.
        room:
          width(area) +
          widthOf(controlElements.filter((element) => element.dataset.fitHidden !== "true")) -
          listPadding -
          (newTab?.offsetWidth ?? 0),
        controls: controls.map((key) =>
          widthOf(controlElements.filter((element) => element.dataset.fitControl === key)),
        ),
        tabs: tabs.map(naturalWidth),
        activeIndex: tabIds.indexOf(activeTabId),
        chip: chip ? width(chip) : 0,
        truncatedTab: TRUNCATED_TAB_PX,
      });
      const shown = next.shown.map((index) => tabIds[index]!);
      const hidden = controls.slice(0, next.hiddenControls);
      setFit((current) =>
        current.mode === next.mode &&
        current.shown.size === shown.length &&
        shown.every((tabId) => current.shown.has(tabId)) &&
        current.hiddenControls.size === hidden.length &&
        hidden.every((key) => current.hiddenControls.has(key))
          ? current
          : { shown: new Set(shown), mode: next.mode, hiddenControls: new Set(hidden) },
      );
    };
    update();
    // Only boxes a fit cannot resize, so applying one inside the callback never loops: the bar
    // for its width, and each title's off-flow copy for its natural width.
    return observeResize([bar, ...titles], update);
  }, [area, tabKey, activeTabId, controlKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a fit can hide the focused tab or control; focus stays in the header so the workspace keeps its keys
  useLayoutEffect(() => {
    const bar = area?.parentElement;
    const focused = document.activeElement;
    if (!area || !bar || !focused || !bar.contains(focused)) return;
    const folded = focused.closest('[data-fit="folded"]');
    if (!folded && !focused.closest('[data-fit-hidden="true"]')) return;
    const chip = area.querySelector<HTMLElement>("[data-fit-chip] button");
    const target = folded
      ? chip?.checkVisibility({ visibilityProperty: true })
        ? chip
        : area.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      : bar.querySelector<HTMLElement>("[data-fit-menu]");
    target?.focus({ preventScroll: true });
  });
  return props.children(fit, setArea);
}

function TerminalMoveMenuItem({ menu }: { menu: TerminalMoveMenu }) {
  if (menu.disabledReason !== null || menu.options === null) {
    return (
      <MenuItem disabled={menu.disabledReason !== null} onClick={() => menu.onMove(null)}>
        <ArrowRightFromLine />
        {menu.label}
        {menu.disabledReason ? <MenuItemDetail>{menu.disabledReason}</MenuItemDetail> : null}
      </MenuItem>
    );
  }
  return (
    <MenuSub>
      <MenuSubTrigger>
        <ArrowRightFromLine />
        {menu.label}
      </MenuSubTrigger>
      <MenuSubPopup>
        {menu.options.map((option) => (
          <MenuItem
            key={option.id}
            disabled={option.disabled}
            onClick={() => menu.onMove(option.id)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.detail ? <MenuItemDetail>{option.detail}</MenuItemDetail> : null}
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

function MenuItemDetail(props: { children: ReactNode }) {
  return (
    <span className="ms-auto shrink-0 ps-4 text-xs text-muted-foreground">{props.children}</span>
  );
}

function TileMenuShortcut(props: { keys: string | null }) {
  return props.keys ? <MenuShortcut>{props.keys}</MenuShortcut> : null;
}

/** A brief green flash confirming a tile bar press; reduced motion skips it. */
function flashPress(button: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  button.classList.remove("tile-press-flash");
  // Reading layout restarts the animation for a repeated press.
  void button.offsetWidth;
  button.classList.add("tile-press-flash");
  button.addEventListener("animationend", () => button.classList.remove("tile-press-flash"), {
    once: true,
  });
}

function TileControl(props: {
  /** Shown only in the tile actions menu. */
  menuOnly?: boolean;
  /** Which priority slot the header fit hides this control by. */
  fit?: TileControlKey;
  hidden?: boolean;
  label: string;
  shortcut?: string | null;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <span
      // Hidden by fit, a control stays measurable but out of the flow, the tab order and view.
      className={cn(
        "shrink-0",
        props.menuOnly ? "hidden" : props.hidden ? "invisible absolute" : "inline-flex",
      )}
      data-fit-control={props.menuOnly ? undefined : props.fit}
      data-fit-hidden={props.hidden}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
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
        <TooltipPopup>
          {props.shortcut ? `${props.label} · ${props.shortcut}` : props.label}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
