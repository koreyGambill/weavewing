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

// Menus and listboxes render in portals outside the workspace that opened them.
const PORTALED_CONTROL = '[role="menu"], [role="listbox"]';
let lastTileOwner: Element | null = null;
let trackingTileFocus = false;

function tileOwnerOf(focused: EventTarget | null): Element | null {
  if (!(focused instanceof Element)) return null;
  const workspace = focused.closest("[data-thread-tiling]");
  if (workspace) return workspace;
  return focused.closest(PORTALED_CONTROL) && lastTileOwner?.isConnected ? lastTileOwner : null;
}

/** Remembers the workspace focus was last in, so a menu it opened still acts on it. */
export function trackTileFocus() {
  if (trackingTileFocus || typeof document === "undefined") return;
  trackingTileFocus = true;
  lastTileOwner = tileOwnerOf(document.activeElement);
  document.addEventListener(
    "focusin",
    (event) => {
      lastTileOwner = tileOwnerOf(event.target);
    },
    true,
  );
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
