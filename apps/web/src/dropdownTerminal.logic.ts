import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelSurface } from "./rightPanelStore";
import { getTileGroups, type ThreadTileLayout } from "./threadTileLayout";

export const DROPDOWN_TERMINAL_MIN_HEIGHT = 160;
export const DROPDOWN_TERMINAL_DEFAULT_HEIGHT = 360;

/**
 * Terminal sessions are keyed by a thread id the server does not need to know, so the drop-down
 * keeps its terminals and tiles under one id per machine that no thread can take.
 */
export function dropdownTerminalRef(environmentId: EnvironmentId): ScopedThreadRef {
  return scopeThreadRef(environmentId, ThreadId.make("dropdown-terminal"));
}

/** Keeps the bottom edge reachable: at least the minimum, at most the window less a margin. */
export function clampDropdownTerminalHeight(height: number, viewportHeight: number): number {
  const max = Math.max(DROPDOWN_TERMINAL_MIN_HEIGHT, viewportHeight - 80);
  return Math.round(Math.min(max, Math.max(DROPDOWN_TERMINAL_MIN_HEIGHT, height)));
}

/** The terminal that takes focus on open: the focused tile's, else any; null starts one. */
export function dropdownTerminalToFocus(
  layout: ThreadTileLayout,
  surfaces: readonly RightPanelSurface[],
): string | null {
  const focused = getTileGroups(layout).find((group) => group.id === layout.focusedGroupId);
  const terminals = surfaces.filter((surface) => surface.kind === "terminal");
  const surface =
    terminals.find((entry) => entry.id === focused?.activeTabId) ??
    terminals.find((entry) =>
      getTileGroups(layout).some((group) => group.activeTabId === entry.id),
    );
  return surface?.resourceId ?? terminals[0]?.resourceId ?? null;
}
