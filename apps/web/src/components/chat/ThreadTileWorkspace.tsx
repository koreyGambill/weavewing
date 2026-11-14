import { useTileResizeGesture } from "./useTileResizeGesture";
import {
  registerCommands,
  registerMenuAction,
  type CommandHandlers,
} from "../../shortcuts/dispatcher";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Columns2,
  Ellipsis,
  Rows2,
  Maximize2,
  Minimize2,
  MessagesSquare,
  PictureInPicture2,
  Plus,
  SquareDashed,
  CircleHelp,
  GripVertical,
  X,
} from "lucide-react";
import type {
  KeybindingCommand,
  ProjectId,
  SavedTileLayout,
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
  isNewTab,
  newTabId,
  getTileGroups,
  boundFloatingTile,
  resizeFloatingTile,
  type FloatingTileEdges,
  type TileNode,
  type FloatingTileRect,
  type TileGroup,
} from "../../threadTileLayout";
import {
  directionalTile,
  tileGeometry,
  displayTileRoot,
  tileDropOrder,
  type TileRect,
} from "../../threadTileGeometry";
import { shortcutLabelForCommand } from "../../keybindings";
import { useTheme } from "../../hooks/useTheme";
import { observeResize } from "../../lib/observeResize";
import { SurfaceIcon, surfaceTitle, type RightPanelTabsProps } from "../RightPanelTabs";
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
import { TILE_AREAS, tileCloseConfirmation, type TileAreaLabel } from "./ThreadTileWorkspace.logic";
import {
  savedTileGroupCount,
  TILE_LAYOUT_AREA_LABELS,
  toSavedTileNode,
} from "../../savedTileLayouts";
import { SaveTileLayoutDialog, TileLayoutsSubmenu } from "./TileLayoutsMenu";
import { useSavedTileLayouts } from "./useSavedTileLayouts";

const TAB_DRAG_TYPE = "application/x-weavewing-tab";
const GROUP_DRAG_TYPE = "application/x-weavewing-group";
type DropZone = "tabs" | "center" | "left" | "right" | "top" | "bottom";
type TileDrop = { groupId: string; zone: DropZone };
type TileDrag = { kind: "tab" | "group"; id: string };
type PanelActions = Omit<RightPanelTabsProps, "children" | "mode" | "inlineSize">;
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
}) {
  const savedLayout = useRightPanelStore((state) =>
    selectThreadTileLayout(state.byThreadKey, props.threadRef),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const tileLayouts = useSavedTileLayouts(props.threadRef.environmentId, props.projectId);
  const [saveLayout, setSaveLayout] = useState<{ dropped: boolean; tiles: number } | null>(null);
  const defaultLayout = props.newThread ? tileLayouts.effectiveDefault : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lays out a new draft once the environment's settings name a default layout
  useEffect(() => {
    if (defaultLayout)
      useRightPanelStore.getState().applySavedTileLayout(props.threadRef, defaultLayout.root, true);
  }, [defaultLayout, props.threadRef]);
  const [dragging, setDragging] = useState<TileDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<TileDrop | null>(null);
  const headerDragBlocked = useRef(false);
  const [resizing, setResizing] = useState(false);
  const [resizeOverride, setResizeOverride] = useState<{ splitId: string; ratio: number } | null>(
    null,
  );
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
  const tiled = (node: TileNode): TileNode | null => {
    if (node.kind === "group") return node.floating ? null : node;
    const first = tiled(node.first);
    const second = tiled(node.second);
    return first && second ? { ...node, first, second } : (first ?? second);
  };
  const dockedRoot = maximized ? displayTileRoot(layout) : tiled(layout.root);
  const floatingGroups = groups.filter((group) => group.floating && !zoomedIds.has(group.id));
  const displayGroups = [...(dockedRoot ? getTileGroups(dockedRoot) : []), ...floatingGroups];
  const dockedGeometry = dockedRoot ? tileGeometry(dockedRoot) : { groups: [], splits: [] };
  const [floatingOverride, setFloatingOverride] = useState<{
    groupId: string;
    rect: FloatingTileRect;
  } | null>(null);
  const visibleGroups = [
    ...dockedGeometry.groups,
    ...floatingGroups.map((group) => ({
      id: group.id,
      rect: floatingOverride?.groupId === group.id ? floatingOverride.rect : group.floating!,
    })),
  ];
  const geometry = { groups: visibleGroups, splits: dockedGeometry.splits };
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
  const apply = (
    action: Parameters<ReturnType<typeof useRightPanelStore.getState>["applyTileAction"]>[1],
  ) =>
    useRightPanelStore
      .getState()
      .applyTileAction(
        props.threadRef,
        action.type === "resize" && action.splitId === "focus-pair-split"
          ? { type: "resize-focus-pair", ratio: action.ratio }
          : action,
      );
  const shortcut = (command: KeybindingCommand) =>
    shortcutLabelForCommand(props.panels.keybindings, command);
  const withShortcut = (label: string, command: KeybindingCommand) => {
    const keys = shortcut(command);
    return keys ? `${label} · ${keys}` : label;
  };
  const title = (id: string) => {
    if (id === CONVERSATION_TAB_ID) return "Main chat";
    if (isNewTab(id)) return "New tab";
    const surface = props.panels.surfaces.find((entry) => entry.id === id);
    return surface
      ? surfaceTitle(surface, props.panels.previewSessions, props.panels.terminalLabelsById)
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
  const split = (
    group: TileGroup,
    axis: "horizontal" | "vertical",
    side: "before" | "after" = "after",
  ) => {
    const groupId = randomUUID();
    apply({
      type: "new-group",
      targetGroupId: group.id,
      axis,
      side,
      groupId,
      splitId: randomUUID(),
    });
    focusChooser(groupId);
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
  // A first float keeps the tile's top right corner, so Dock lands where Float was.
  const anchoredFloat = (groupId: string) => {
    const root = tiled(currentLayout().root);
    const docked = root && tileGeometry(root).groups.find((entry) => entry.id === groupId)?.rect;
    if (!docked) return DEFAULT_FLOATING_TILE;
    const right = docked.x + docked.width;
    const width = Math.max(0.2, Math.min(DEFAULT_FLOATING_TILE.width, right));
    const height = Math.max(0.2, Math.min(DEFAULT_FLOATING_TILE.height, 1 - docked.y));
    return { width, height, x: right - width, y: docked.y };
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
    const group = getTileGroups(currentLayout()).find((entry) => entry.id === groupId);
    if (group?.tabs.length && !isNewTab(group.activeTabId))
      apply({ type: "new-tab", groupId, tabId: newTabId(randomUUID()) });
    else apply({ type: "focus", groupId });
    focusChooser(groupId);
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
    if (group.tabs.length === 0 || isNewTab(group.activeTabId)) {
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
  const openablePending = Object.entries(savedLayout.pendingAreas ?? {}).filter(
    ([, area]) => areaRuns[TILE_LAYOUT_AREA_LABELS[area]][0],
  );
  const requestedPending = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens a fresh surface for each saved-layout placeholder once its area becomes available
  useEffect(() => {
    for (const [tabId, area] of openablePending) {
      if (requestedPending.current.has(tabId)) continue;
      requestedPending.current.add(tabId);
      areaRuns[TILE_LAYOUT_AREA_LABELS[area]][1]?.();
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
    return TILE_AREAS.flatMap(({ label, key }) => {
      const [enabled, run] = runs[label];
      return enabled
        ? [
            {
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
                parkFocus(groupId);
                if (label === "Main chat")
                  apply({ type: "move", tabId: CONVERSATION_TAB_ID, targetGroupId: groupId });
                else {
                  apply({ type: "focus", groupId });
                  run?.();
                }
                focus(groupId);
              },
            },
          ]
        : [];
    });
  })();
  const firstOpenable = Math.max(
    0,
    areaChoices.findIndex((choice) => !choice.openElsewhere),
  );
  const restoreZoom = () => apply({ type: "maximize", groupId: null });
  const saveLayoutAs = () => {
    const { root, dropped } = toSavedTileNode(currentLayout());
    setSaveLayout({ dropped, tiles: root ? savedTileGroupCount(root) : 0 });
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
    const visibleGeometry = () => {
      const current = currentLayout();
      const root = current.maximizedGroupId ? displayTileRoot(current) : tiled(current.root);
      return [
        ...(root ? tileGeometry(root).groups : []),
        ...getTileGroups(current)
          .filter(
            (group) =>
              group.floating &&
              group.id !== current.maximizedGroupId &&
              group.id !== current.besideGroupId,
          )
          .map((group) => ({ id: group.id, rect: group.floating! })),
      ];
    };
    const moveFocus = (direction: "left" | "right" | "up" | "down") => {
      const group = currentGroup();
      if (!group) return;
      const next = directionalTile(visibleGeometry(), group.id, direction);
      if (next) focus(next);
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
      if (!group || group.tabs.length === 0) return;
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
      "workspace.tile.swap": () => apply({ type: "swap-beside" }),
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
        if (!group) return;
        if (group.tabs.length) closeTab(group.activeTabId);
        else closeTile(group.id);
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
      if (group && (!group.tabs.length || isNewTab(group.activeTabId)) && !editing && inChooser) {
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
            apply(
              group.tabs.length
                ? { type: "close-tab", tabId: group.activeTabId }
                : { type: "close-group", groupId: group.id },
            );
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
          ),
      }),
      ...Object.entries(actions).map(([command, run]) => registerMenuAction(command, run)),
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
  }, [layoutIds]);

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
    const edges = [
      { zone: "left" as const, distance: localX },
      { zone: "right" as const, distance: 1 - localX },
      { zone: "top" as const, distance: localY },
      { zone: "bottom" as const, distance: 1 - localY },
    ];
    const nearest = edges.reduce((a, b) => (a.distance < b.distance ? a : b));
    return { groupId: hovered.id, zone: nearest.distance < 0.22 ? nearest.zone : "center" };
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
    const initial = group.floating;
    let rect = initial;
    setResizing(true);
    const move = (next: PointerEvent) => {
      const delta = {
        x: (next.clientX - event.clientX) / bounds.width,
        y: (next.clientY - event.clientY) / bounds.height,
      };
      rect = edges
        ? resizeFloatingTile(initial, edges, delta)
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
  const zoomLabel = layout.besideGroupId ? "2 tiles" : "Maximized";
  const zoomAccent = `var(--tile-accent-${groups.find((group) => group.id === maximized)?.colorIndex ?? 0})`;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-thread-tiling>
      <div className="relative shrink-0">
        {props.header}
        {maximized && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <button
              type="button"
              className="pointer-events-auto h-6 cursor-pointer rounded-full border px-3 text-xs font-medium text-foreground outline-none [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              style={{
                background: `color-mix(in srgb, ${zoomAccent} 18%, var(--background))`,
                borderColor: `color-mix(in srgb, ${zoomAccent} 45%, transparent)`,
              }}
              onClick={restoreZoom}
            >
              {zoomLabel} · Esc to restore
            </button>
          </div>
        )}
      </div>
      <div
        ref={rootRef}
        className="relative isolate min-h-0 min-w-0 flex-1 overflow-hidden bg-border/40"
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
          if (target) {
            const { groupId: targetGroupId, zone } = target;
            const edge = zone !== "center" && zone !== "tabs";
            if (dragging.kind === "group") {
              if (edge)
                apply({
                  type: "dock-group",
                  groupId: dragging.id,
                  targetGroupId,
                  axis: zone === "left" || zone === "right" ? "horizontal" : "vertical",
                  side: zone === "left" || zone === "top" ? "before" : "after",
                  splitId: randomUUID(),
                });
              else if (zone === "tabs")
                apply({ type: "merge-groups", groupId: dragging.id, targetGroupId });
              else
                apply({
                  type: "swap-groups",
                  firstGroupId: dragging.id,
                  secondGroupId: targetGroupId,
                });
            } else if (edge)
              apply({
                type: "split",
                tabId: dragging.id,
                targetGroupId,
                axis: zone === "left" || zone === "right" ? "horizontal" : "vertical",
                side: zone === "left" || zone === "top" ? "before" : "after",
                groupId: randomUUID(),
                splitId: randomUUID(),
              });
            else {
              const tabElement =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>("[data-tab-id]")
                  : null;
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
          }
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
                "workspace-tile-frame @container/tile absolute overflow-hidden bg-background outline-none",
                group.floating && "shadow-2xl",
              )}
              data-focused={focusedGroupId === id}
              aria-label={`Tile: ${title(group.activeTabId)}`}
              data-tile-group={id}
              tabIndex={-1}
            >
              <div
                className="workspace-tile-titlebar flex min-w-0 cursor-grab items-center justify-end gap-0.5 px-1 active:cursor-grabbing"
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
                <GripVertical aria-hidden className="workspace-tile-grip size-3 shrink-0" />
                <span
                  className="workspace-tile-grip shrink-0 text-2xs tabular-nums"
                  aria-label={`Group ${groupNumber}`}
                >
                  {groupNumber}
                </span>
                <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                  <div
                    // Filling the bar keeps New tab in one place as tabs open and close.
                    className="workspace-tile-tabs flex min-w-0 flex-1 items-center overflow-x-auto px-1"
                    ref={observeTabStrip}
                    onScroll={(event) => markTabOverflow(event.currentTarget)}
                    role="tablist"
                    aria-label="Tile tabs"
                  >
                    {group.tabs.map((tabId) => {
                      const surface = props.panels.surfaces.find((entry) => entry.id === tabId);
                      const session =
                        surface?.kind === "preview" && surface.resourceId
                          ? props.panels.previewSessions[surface.resourceId]
                          : null;
                      const previewUrl =
                        session && session.navStatus._tag !== "Idle" ? session.navStatus.url : null;
                      return (
                        <div
                          key={tabId}
                          ref={group.activeTabId === tabId ? revealTab : undefined}
                          className="workspace-tile-tab flex max-w-44 shrink items-center rounded-sm"
                          data-active={group.activeTabId === tabId}
                        >
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
                            <span className="min-w-10 truncate">{title(tabId)}</span>
                          </button>
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
                  {group.tabs.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-micro"
                            variant="ghost"
                            aria-label="New tab"
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
                  )}
                </div>
                <TileControl
                  label="New tile to the right"
                  shortcut={shortcut("workspace.tile.splitRight")}
                  onClick={() => split(group, "horizontal")}
                >
                  <Columns2 />
                </TileControl>
                <TileControl
                  label="New tile below"
                  shortcut={shortcut("workspace.tile.splitDown")}
                  onClick={() => split(group, "vertical")}
                >
                  <Rows2 />
                </TileControl>
                <TileControl
                  label={group.floating ? "Dock tile" : "Float tile"}
                  shortcut={shortcut("workspace.tile.float")}
                  pressed={Boolean(group.floating)}
                  disabled={(!group.floating && dockedCount < 2) || zoomedIds.has(id)}
                  onClick={() => toggleFloat(group)}
                >
                  <PictureInPicture2 />
                </TileControl>
                <TileControl
                  label={zoomedIds.has(id) ? "Restore tiles" : "Maximize tile"}
                  shortcut={shortcut("workspace.tile.maximize")}
                  pressed={zoomedIds.has(id)}
                  onClick={() =>
                    apply({ type: "maximize", groupId: zoomedIds.has(id) ? null : id })
                  }
                >
                  {zoomedIds.has(id) ? <Minimize2 /> : <Maximize2 />}
                </TileControl>
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
                            <Button size="icon-micro" variant="ghost" aria-label="Tile actions" />
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
                    {maximized === id && others.length > 0 && (
                      <MenuGroup>
                        <MenuGroupLabel>Show beside…</MenuGroupLabel>
                        {others.map((entry) => (
                          <MenuItem
                            key={entry.id}
                            onClick={() => apply({ type: "show-beside", groupId: entry.id })}
                          >
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ background: `var(--tile-accent-${entry.colorIndex ?? 0})` }}
                            />
                            {groups.indexOf(entry) + 1}. {title(entry.activeTabId)}
                          </MenuItem>
                        ))}
                        <MenuSeparator />
                      </MenuGroup>
                    )}
                    {layout.besideGroupId && zoomedIds.has(id) && (
                      <MenuItem onClick={() => apply({ type: "swap-beside" })}>
                        Swap sides
                        <TileMenuShortcut keys={shortcut("workspace.tile.swap")} />
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() =>
                        apply({ type: "maximize", groupId: zoomedIds.has(id) ? null : id })
                      }
                    >
                      {zoomedIds.has(id) ? "Restore tiles" : "Maximize tile"}
                      <TileMenuShortcut keys={shortcut("workspace.tile.maximize")} />
                    </MenuItem>
                    <MenuItem
                      disabled={(!group.floating && dockedCount < 2) || zoomedIds.has(id)}
                      onClick={() => toggleFloat(group)}
                    >
                      {group.floating ? "Dock tile" : "Float tile"}
                      <TileMenuShortcut keys={shortcut("workspace.tile.float")} />
                    </MenuItem>
                    <MenuItem onClick={() => openNewTab(id)}>
                      New tab
                      <TileMenuShortcut keys={shortcut("workspace.tile.newTab")} />
                    </MenuItem>
                    <MenuItem onClick={() => split(group, "horizontal")}>
                      New tile to the right
                      <TileMenuShortcut keys={shortcut("workspace.tile.splitRight")} />
                    </MenuItem>
                    <MenuItem onClick={() => split(group, "vertical")}>
                      New tile below
                      <TileMenuShortcut keys={shortcut("workspace.tile.splitDown")} />
                    </MenuItem>
                    <MenuSub>
                      <MenuSubTrigger disabled={group.tabs.length < 2}>
                        Move tab to new tile
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        <MenuItem onClick={() => moveTabToNewTile(group, "horizontal")}>
                          Right
                        </MenuItem>
                        <MenuItem onClick={() => moveTabToNewTile(group, "vertical")}>
                          Below
                        </MenuItem>
                      </MenuSubPopup>
                    </MenuSub>
                    <MenuSeparator />
                    <TileLayoutsSubmenu
                      api={tileLayouts}
                      hasProject={tileLayouts.projectId !== null}
                      onSaveAs={saveLayoutAs}
                      onApply={applySavedLayout}
                    />
                    <MenuSeparator />
                    <MenuItem disabled={lastBlankTab} onClick={() => closeTab(group.activeTabId)}>
                      Close tab
                      <TileMenuShortcut keys={shortcut("workspace.tile.closeTab")} />
                    </MenuItem>
                    <MenuItem disabled={groups.length === 1 && blank} onClick={() => closeTile(id)}>
                      Close tile
                    </MenuItem>
                  </MenuPopup>
                </Menu>
                <TileControl
                  label={blank ? "Close empty tile" : "Close tile"}
                  disabled={groups.length === 1 && blank}
                  onClick={() => closeTile(id)}
                >
                  <X />
                </TileControl>
              </div>
              {(group.tabs.length === 0 || isNewTab(group.activeTabId)) && (
                <div
                  className="flex h-full flex-col items-center justify-center gap-4 p-6 outline-none"
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
                  <p className="text-sm font-medium">Choose an area</p>
                  {savedLayout.pendingAreas?.[group.activeTabId] && (
                    <p className="-mt-2 text-xs text-muted-foreground">
                      {TILE_LAYOUT_AREA_LABELS[savedLayout.pendingAreas[group.activeTabId]!]} opens
                      here once it is available.
                    </p>
                  )}
                  <div
                    className="flex max-w-md flex-wrap justify-center gap-2"
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
                          aria-keyshortcuts={choice.key.toUpperCase()}
                          aria-disabled={choice.openElsewhere ? true : undefined}
                          aria-description={openNote ?? undefined}
                          onClick={() => choice.run(id)}
                        >
                          {choice.label}
                          <Kbd
                            aria-hidden
                            variant={
                              chooserActive && index === chooserSelection ? "primary" : "default"
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
                  <p className="text-xs text-muted-foreground">
                    Press a letter, or use the arrows and Enter.
                    {lastBlankTab
                      ? ""
                      : group.tabs.length > 1
                        ? " Esc closes this tab."
                        : " Esc closes this tile."}
                  </p>
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
              Resize · release to keep · Esc to cancel
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
      {saveLayout && (
        <SaveTileLayoutDialog
          open
          onOpenChange={(open) => {
            if (!open) setSaveLayout(null);
          }}
          layouts={tileLayouts.layouts}
          dropped={saveLayout.dropped}
          tiles={saveLayout.tiles}
          onSave={(name) => {
            const { root } = toSavedTileNode(currentLayout());
            if (root) tileLayouts.save(name, root);
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
      <div className="pointer-events-none absolute right-1 bottom-1 z-20">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="pointer-events-auto rounded bg-background p-1 text-muted-foreground"
                tabIndex={0}
                aria-label="Tiling shortcuts"
              />
            }
          >
            <CircleHelp className="size-3" />
          </TooltipTrigger>
          <TooltipPopup>
            Ctrl+Alt+arrows or H/J/K/L: focus tile. Hold Ctrl+Alt+R and move the mouse: resize. Add
            Shift: new tile on that side. Ctrl+Alt+Enter: maximize. Ctrl+Alt+[ or ] / Ctrl+Tab:
            switch tab. Drag a tab to group it or split at an edge. Drag the title bar to move the
            whole tile.
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

const TAB_FADE_PX = 24;

// A tab cut at the strip's start is masked out whole, so no stray close button shows, and the
// end fades to show more tabs follow without ever dimming the active tab.
function markTabOverflow(strip: HTMLElement) {
  const bounds = strip.getBoundingClientRect();
  const cut = [...strip.children].find((tab) => {
    const rect = tab.getBoundingClientRect();
    return rect.left < bounds.left - 0.5 && rect.right > bounds.left + 0.5;
  });
  const clip = cut ? cut.getBoundingClientRect().right - bounds.left : 0;
  const overflowEnd = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  const activeRight = strip.querySelector('[data-active="true"]')?.getBoundingClientRect().right;
  const fade = overflowEnd
    ? Math.max(0, Math.min(TAB_FADE_PX, bounds.right - (activeRight ?? bounds.left)))
    : 0;
  strip.style.setProperty("--tile-tabs-clip", `${clip}px`);
  strip.style.setProperty("--tile-tabs-fade-end", `${fade}px`);
  strip.dataset.masked = String(clip > 0 || fade > 0);
}

// Tab labels change width after they mount (a terminal names its process) and splitting a tile
// narrows its strip, so the active tab is revealed again whenever the strip or a tab resizes.
function observeTabStrip(strip: HTMLElement | null) {
  if (!strip) return;
  let unobserve = () => {};
  const watch = () => {
    unobserve();
    unobserve = observeResize([strip, ...strip.children], () => {
      const active = strip.querySelector<HTMLElement>(':scope > [data-active="true"]');
      if (active) revealTab(active);
      else markTabOverflow(strip);
    });
  };
  const mutations = new MutationObserver(watch);
  mutations.observe(strip, { childList: true });
  watch();
  return () => {
    mutations.disconnect();
    unobserve();
  };
}

// Scrolls only the tab strip, to a whole-tab boundary, so no cut-off tab sits at its start
// and an overflow-hidden workspace never shifts.
function revealTab(tab: HTMLElement | null) {
  const strip = tab?.parentElement;
  if (!tab || !strip) return;
  const origin = strip.getBoundingClientRect().left - strip.scrollLeft;
  const pad = Number.parseFloat(getComputedStyle(strip).paddingLeft) || 0;
  const startOf = (element: Element) => element.getBoundingClientRect().left - origin - pad;
  const start = startOf(tab);
  // Room for the end fade when tabs follow, so it lands on them rather than this one, but
  // never so much that a narrow strip scrolls the tab itself out of view.
  const fadeRoom = tab.nextElementSibling
    ? Math.min(TAB_FADE_PX, Math.max(0, strip.clientWidth - tab.offsetWidth - 2 * pad))
    : 0;
  const end = start + tab.offsetWidth + 2 * pad + fadeRoom;
  if (start < strip.scrollLeft) strip.scrollLeft = start;
  else if (end > strip.scrollLeft + strip.clientWidth)
    strip.scrollLeft = Math.min(
      start,
      [...strip.children].map(startOf).find((edge) => edge >= end - strip.clientWidth) ?? start,
    );
  markTabOverflow(strip);
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
  label: string;
  shortcut?: string | null;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0">
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
