import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DROPDOWN_TERMINAL_THREAD_ID,
  isDropdownTerminalThreadId,
  ThreadId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { isEnvironmentOnThisComputer } from "./connection/desktopLocal";
import { randomUUID } from "./lib/utils";
import type { DropdownTerminalTab, DropdownTerminalTarget } from "./dropdownTerminalStore";
import type { RightPanelSurface } from "./rightPanelStore";
import { getTileGroups, type ThreadTileLayout } from "./threadTileLayout";

const DROPDOWN_TERMINAL_MIN_HEIGHT = 160;
export const DROPDOWN_TERMINAL_DEFAULT_HEIGHT = 360;

export function dropdownTerminalTarget(
  environment: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly entry: { readonly target: ConnectionTarget };
  },
  primaryEnvironmentId: EnvironmentId | null,
  isDesktop: boolean,
): DropdownTerminalTarget {
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    external:
      environment.environmentId !== primaryEnvironmentId &&
      !isEnvironmentOnThisComputer(environment.entry.target, isDesktop),
  };
}

/**
 * Terminal sessions are keyed by a thread id the server does not need to know, so each drop-down
 * tab keeps its terminals and tiles under its own id that no thread can take.
 */
export function dropdownTerminalRef(
  environmentId: EnvironmentId,
  tabId: string = DROPDOWN_TERMINAL_THREAD_ID,
): ScopedThreadRef {
  return scopeThreadRef(environmentId, ThreadId.make(tabId));
}

function restoreTarget(saved: unknown): DropdownTerminalTarget | null {
  if (typeof saved !== "object" || saved === null) return null;
  const { environmentId, label, external } = saved as Record<string, unknown>;
  return typeof environmentId === "string" && environmentId !== "" && typeof label === "string"
    ? { environmentId: environmentId as EnvironmentId, label, external: external === true }
    : null;
}

/** Saved tabs that still name a drop-down key, or null when none survive. */
export function restoreDropdownTerminalTabs(saved: unknown): DropdownTerminalTab[] | null {
  if (!Array.isArray(saved)) return null;
  const seen = new Set<string>();
  const tabs = saved.flatMap((entry: unknown): DropdownTerminalTab[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name, target } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !isDropdownTerminalThreadId(id) || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: typeof name === "string" && name.trim() !== "" ? name : null,
        target: restoreTarget(target),
      },
    ];
  });
  return tabs.length > 0 ? tabs : null;
}

export function newDropdownTerminalTabId(): string {
  return `${DROPDOWN_TERMINAL_THREAD_ID}-${randomUUID()}`;
}

/** The tab a terminal moved to `environmentId` joins: the active one when it runs there, else the first that does. */
export function dropdownTerminalTabFor(
  state: { readonly tabs: readonly DropdownTerminalTab[]; readonly activeTabId: string },
  environmentId: EnvironmentId,
): DropdownTerminalTab | null {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (active?.target?.environmentId === environmentId) return active;
  return state.tabs.find((tab) => tab.target?.environmentId === environmentId) ?? null;
}

/** The tab a 1-based jump key picks; 9 always picks the last, as browsers do. */
export function dropdownTerminalTabAt(
  tabs: readonly DropdownTerminalTab[],
  position: number,
): DropdownTerminalTab | null {
  return (position === 9 ? tabs.at(-1) : tabs[position - 1]) ?? null;
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

/** A thread a drop-down terminal can move into; `reason` says why it cannot. */
export interface DropdownTerminalMoveTarget {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly shown: boolean;
  readonly reason: string | null;
}

const DROPDOWN_TERMINAL_MOVE_TARGET_LIMIT = 6;

/**
 * Threads a drop-down terminal on `environmentId` can move into: the shown thread first, then the
 * machine's most recently updated others. A shown thread on another machine stays listed, disabled,
 * because sessions cannot cross machines.
 */
export function dropdownTerminalMoveTargets(input: {
  readonly environmentId: EnvironmentId;
  readonly shownThreadRef: ScopedThreadRef | null;
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
    readonly worktreePath: string | null;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  }>;
}): DropdownTerminalMoveTarget[] {
  const shown = input.shownThreadRef;
  const isShown = (thread: (typeof input.threads)[number]) =>
    shown !== null && thread.environmentId === shown.environmentId && thread.id === shown.threadId;
  const target = (
    thread: (typeof input.threads)[number],
    reason: string | null,
  ): DropdownTerminalMoveTarget => ({
    threadRef: scopeThreadRef(thread.environmentId, thread.id),
    title: thread.title,
    worktreePath: thread.worktreePath,
    shown: isShown(thread),
    reason,
  });
  const shownThread = input.threads.find(isShown);
  const others = input.threads
    .filter(
      (thread) =>
        thread.environmentId === input.environmentId &&
        thread.archivedAt === null &&
        !isShown(thread),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => target(thread, null));
  const first = shownThread
    ? [
        target(
          shownThread,
          shownThread.environmentId === input.environmentId ? null : "On another machine",
        ),
      ]
    : [];
  return [...first, ...others].slice(0, DROPDOWN_TERMINAL_MOVE_TARGET_LIMIT);
}
