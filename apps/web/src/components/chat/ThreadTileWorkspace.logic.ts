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
