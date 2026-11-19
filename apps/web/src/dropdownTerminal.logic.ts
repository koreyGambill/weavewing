import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelSurface } from "./rightPanelStore";
import { getTileGroups, type ThreadTileLayout } from "./threadTileLayout";

const DROPDOWN_TERMINAL_MIN_HEIGHT = 160;
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
