import type { RightPanelSurface } from "../../rightPanelStore";
import { isNewTab } from "../../threadTileLayout";

export const TILE_AREAS = [
  { label: "Main chat", key: "c" },
  { label: "Browser", key: "b" },
  { label: "Terminal", key: "t" },
  { label: "Files", key: "f" },
  { label: "Notes", key: "n" },
  { label: "Diff", key: "d" },
  { label: "Pull request", key: "p" },
  { label: "Pull requests", key: "l" },
  { label: "Device", key: "v" },
  { label: "Side chat", key: "s" },
] as const;
export type TileAreaLabel = (typeof TILE_AREAS)[number]["label"];

/** What closing a whole tile asks first, or null when it can close at once. */
export function tileCloseConfirmation(input: {
  tabIds: readonly string[];
  surfaces: readonly RightPanelSurface[];
  runningTerminalIds: readonly string[];
  terminalLabelsById: ReadonlyMap<string, string>;
}): { title: string; description: string | null } | null {
  const running = input.surfaces
    .filter((surface) => input.tabIds.includes(surface.id))
    .flatMap((surface) => (surface.kind === "terminal" ? [surface.resourceId] : []))
    .filter((terminalId) => input.runningTerminalIds.includes(terminalId))
    .map((terminalId) => input.terminalLabelsById.get(terminalId) ?? "A terminal process");
  const count = input.tabIds.filter((tabId) => !isNewTab(tabId)).length;
  const title = count > 1 ? `Close all ${count} tabs in this tile?` : "Close this tile?";
  if (running.length === 0) return null;
  const names =
    running.length === 1
      ? running[0]!
      : `${running.slice(0, -1).join(", ")} and ${running.at(-1)!}`;
  return {
    title,
    description: `${names} ${running.length === 1 ? "is" : "are"} still running and will be stopped.`,
  };
}

// A portaled menu or listbox belongs to the workspace of the trigger whose aria-controls names
// it or its popup; submenus chain through their parent menu's trigger, a few levels at most.
function tileOwnerOf(focused: EventTarget | null): Element | null {
  let element = focused instanceof Element ? focused : null;
  for (let hops = 0; element && hops < 8; hops += 1) {
    const workspace = element.closest("[data-thread-tiling]");
    if (workspace) return workspace;
    let popup = element.closest('[role="menu"], [role="listbox"]');
    element = null;
    for (; popup && !element; popup = popup.parentElement) {
      if (popup.id) element = document.querySelector(`[aria-controls="${CSS.escape(popup.id)}"]`);
    }
  }
  return null;
}

/**
 * Whether a tile key or menu action belongs to this workspace: the one holding focus, or whose
 * menu holds it, takes it; with focus elsewhere it goes to the one underneath, never an overlay.
 */
export function ownsTileInput(
  workspace: Element | null,
  focused: EventTarget | null,
  overlay: boolean,
): boolean {
  const owner = tileOwnerOf(focused);
  return owner ? workspace !== null && owner.contains(workspace) : !overlay;
}

/** Header controls in the order they give way, before any tab folds, as a tile narrows. */
export const TILE_CONTROL_PRIORITY = ["split", "float", "maximize", "close"] as const;
export type TileControlKey = (typeof TILE_CONTROL_PRIORITY)[number];

export type TileTabFit = {
  /** Indices of the tabs shown in full, in tile order; the rest fold into the +N chip. */
  shown: readonly number[];
  /** "truncated" and "icon" apply to the active tab when it is the only one shown. */
  mode: "full" | "truncated" | "icon";
  /** How many controls, from the front of the priority list, are hidden. */
  hiddenControls: number;
};

// Sub-pixel slack, so a tab that measures exactly the room left still shows.
const FIT_EPSILON = 0.5;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Which tabs and controls a tile header shows. Controls hide in priority order before any tab
 * folds; then tabs show left to right with the rest behind a +N chip, the active tab taking the
 * last place when it falls past the cutoff. A lone active tab truncates, then shows its icon.
 */
export function fitTileTabs(input: {
  /** Width for tabs and the chip once every control is hidden. */
  room: number;
  /** Control widths, gap included, in the order they hide. */
  controls: readonly number[];
  tabs: readonly number[];
  activeIndex: number;
  chip: number;
  /** The narrowest the lone active tab may be while it keeps its title. */
  truncatedTab: number;
}): TileTabFit {
  const { room, controls, tabs, activeIndex } = input;
  const all = tabs.map((_, index) => index);
  let controlsWidth = sum(controls);
  for (let hidden = 0; hidden <= controls.length; hidden += 1) {
    if (sum(tabs) <= room - controlsWidth + FIT_EPSILON)
      return { shown: all, mode: "full", hiddenControls: hidden };
    controlsWidth -= controls[hidden] ?? 0;
  }
  const hiddenControls = controls.length;
  if (activeIndex < 0) return { shown: [], mode: "full", hiddenControls };
  for (let count = tabs.length - 1; count >= 1; count -= 1) {
    const shown =
      activeIndex < count ? all.slice(0, count) : [...all.slice(0, count - 1), activeIndex];
    if (sum(shown.map((index) => tabs[index]!)) + input.chip <= room + FIT_EPSILON)
      return { shown, mode: "full", hiddenControls };
  }
  const chip = tabs.length > 1 ? input.chip : 0;
  const truncates =
    input.truncatedTab < tabs[activeIndex]! && input.truncatedTab + chip <= room + FIT_EPSILON;
  return { shown: [activeIndex], mode: truncates ? "truncated" : "icon", hiddenControls };
}
