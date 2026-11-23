import type { EnvironmentId, MessageFollowUp } from "@t3tools/contracts";
import { create } from "zustand";

import { adjacentBookmark, bookmarkKey } from "../reviews/bookmarks.logic";

/**
 * Bookmark state the command palette and keyboard shortcuts read from outside the transcript.
 * It holds data only: a callback from a timeline render would keep that render's thread
 * structures alive after the thread is replaced.
 */

let selectionToggle: (() => void) | null = null;

/** Bookmarks, or unbookmarks, the passage the selection toolbar currently shows. */
export function setSelectionBookmarkToggle(toggle: (() => void) | null): () => void {
  selectionToggle = toggle;
  return () => {
    if (selectionToggle === toggle) selectionToggle = null;
  };
}

export function selectionBookmarkToggle(): (() => void) | null {
  return selectionToggle;
}

interface ThreadBookmarkTrail {
  readonly environmentId: EnvironmentId;
  /** In transcript order. */
  readonly bookmarks: ReadonlyArray<MessageFollowUp>;
  readonly currentKey: string | null;
}

export const useThreadBookmarkTrails = create<Readonly<Record<string, ThreadBookmarkTrail>>>(
  () => ({}),
);

const NO_BOOKMARKS: ReadonlyArray<MessageFollowUp> = [];

/**
 * Offers a shown thread's bookmarks to next and previous while its rail is mounted. Taking them
 * away keeps the current bookmark, so a list that changes under it does not restart navigation.
 */
export function publishThreadBookmarks(
  threadKey: string,
  environmentId: EnvironmentId,
  bookmarks: ReadonlyArray<MessageFollowUp>,
): () => void {
  useThreadBookmarkTrails.setState((trails) => ({
    ...trails,
    [threadKey]: { environmentId, bookmarks, currentKey: trails[threadKey]?.currentKey ?? null },
  }));
  return () =>
    useThreadBookmarkTrails.setState((trails) => {
      const trail = trails[threadKey];
      return trail?.bookmarks === bookmarks
        ? { ...trails, [threadKey]: { ...trail, bookmarks: NO_BOOKMARKS } }
        : trails;
    });
}

export function markCurrentThreadBookmark(threadKey: string, bookmark: MessageFollowUp) {
  useThreadBookmarkTrails.setState((trails) => {
    const trail = trails[threadKey];
    return trail
      ? { ...trails, [threadKey]: { ...trail, currentKey: bookmarkKey(bookmark) } }
      : trails;
  });
}

/** The next or previous bookmark of a shown thread, marked current; null when it has none. */
export function stepThreadBookmark(
  threadKey: string,
  direction: "next" | "previous",
): { readonly environmentId: EnvironmentId; readonly bookmark: MessageFollowUp } | null {
  const trail = useThreadBookmarkTrails.getState()[threadKey];
  const bookmark = trail && adjacentBookmark(trail.bookmarks, trail.currentKey, direction);
  if (!trail || !bookmark) return null;
  markCurrentThreadBookmark(threadKey, bookmark);
  return { environmentId: trail.environmentId, bookmark };
}

/** How many bookmarks a shown thread offers; components re-render as it changes. */
export function useThreadBookmarkCount(threadKey: string | null): number {
  return useThreadBookmarkTrails((trails) =>
    threadKey === null ? 0 : (trails[threadKey]?.bookmarks.length ?? 0),
  );
}

export function hasThreadBookmarks(threadKey: string): boolean {
  return (useThreadBookmarkTrails.getState()[threadKey]?.bookmarks.length ?? 0) > 0;
}
