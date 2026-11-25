import type {
  EnvironmentId,
  MessageFollowUp,
  MessageFollowUpUpdateInput,
  SideChatAnchor,
} from "@t3tools/contracts";

import {
  assistantCitationNavigation,
  messageRevealNavigation,
} from "../../lib/assistantCitationNavigation";
import { findAssistantCitationText } from "../../lib/assistantTextSelection";

/** Servers before bookmarks send no id: their one bookmark per message is the whole message. */
export const bookmarkKey = (bookmark: MessageFollowUp) => bookmark.id ?? bookmark.messageId;

export function bookmarkUpdate(
  bookmark: MessageFollowUp,
  action: MessageFollowUpUpdateInput["action"],
): MessageFollowUpUpdateInput {
  return {
    threadId: bookmark.threadId,
    messageId: bookmark.messageId,
    action,
    ...(bookmark.id === undefined ? {} : { bookmarkId: bookmark.id }),
  };
}

/**
 * The passage bookmark a selection lands on, so the toolbar can offer to remove it. Saved
 * passages are found again in the message's current text, as the tint finds them, so a passage
 * whose text moved is matched where it now is and one that no longer resolves matches nothing.
 */
export function findOverlappingBookmark(
  bookmarks: ReadonlyArray<MessageFollowUp>,
  selection: Pick<SideChatAnchor, "messageId" | "start" | "end">,
  messageText: string,
): MessageFollowUp | null {
  return (
    bookmarks.find((bookmark) => {
      if (bookmark.anchor === undefined || bookmark.messageId !== selection.messageId) {
        return false;
      }
      const found = findAssistantCitationText(messageText, bookmark.anchor);
      return found !== null && found.start < selection.end && selection.start < found.end;
    }) ?? null
  );
}

const messageTime = (bookmark: MessageFollowUp) =>
  Date.parse(bookmark.messageCreatedAt ?? bookmark.flaggedAt);

/** Transcript order: by message, then a whole message before its passages, then by passage. */
export function orderBookmarks(
  bookmarks: ReadonlyArray<MessageFollowUp>,
): ReadonlyArray<MessageFollowUp> {
  return bookmarks.toSorted(
    (a, b) =>
      messageTime(a) - messageTime(b) ||
      (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0) ||
      (a.anchor?.start ?? -1) - (b.anchor?.start ?? -1),
  );
}

/** Steps through ordered bookmarks and wraps; with none visited yet, starts at an end. */
export function adjacentBookmark(
  ordered: ReadonlyArray<MessageFollowUp>,
  currentKey: string | null,
  direction: "next" | "previous",
): MessageFollowUp | null {
  if (ordered.length === 0) return null;
  const at =
    currentKey === null ? -1 : ordered.findIndex((item) => bookmarkKey(item) === currentKey);
  if (at === -1) return direction === "next" ? ordered[0]! : ordered.at(-1)!;
  const step = direction === "next" ? 1 : -1;
  return ordered[(at + step + ordered.length) % ordered.length]!;
}

/** Reveals the bookmarked passage, or the whole message, in its thread. */
export function bookmarkNavigation(environmentId: EnvironmentId, bookmark: MessageFollowUp) {
  return bookmark.anchor === undefined
    ? messageRevealNavigation(environmentId, bookmark.threadId, bookmark.messageId)
    : assistantCitationNavigation(
        { version: 1, environmentId, threadId: bookmark.threadId, ...bookmark.anchor },
        null,
      );
}

/** Reveals a bookmark in the thread this view already shows, keeping the current route and tiles. */
export function bookmarkInPlaceNavigation(environmentId: EnvironmentId, bookmark: MessageFollowUp) {
  const { hash, state } = bookmarkNavigation(environmentId, bookmark);
  return { to: ".", hash, state, resetScroll: false } as const;
}

/** Bars closer than this many pixels read as one, so the rail merges them. */
const RAIL_BAR_MIN_GAP_PX = 8;

export interface BookmarkRailBar {
  /** Percent of the rail's height, matching the left minimap's strips. */
  readonly top: number;
  /** In transcript order; more than one means a merged bar with a chooser. */
  readonly bookmarks: ReadonlyArray<MessageFollowUp>;
}

/**
 * Places each bookmark beside the minimap turn it falls in: the last turn that started at or
 * before its message. `turnTimes` are the minimap items' times in their order, null when unknown.
 * Bookmarks whose bars would sit closer than a few pixels on a rail `railHeight` pixels tall share
 * one bar, so a crowded or compressed rail stays legible.
 */
export function bookmarkRailBars(
  ordered: ReadonlyArray<MessageFollowUp>,
  turnTimes: ReadonlyArray<number | null>,
  railHeight: number,
): ReadonlyArray<BookmarkRailBar> {
  const slots = Math.max(1, turnTimes.length);
  const known: Array<{ readonly time: number; readonly turn: number }> = [];
  for (const [turn, time] of turnTimes.entries()) {
    if (time !== null && (known.length === 0 || time >= known.at(-1)!.time)) {
      known.push({ time, turn });
    }
  }
  const turnOf = (time: number) => {
    let low = 0;
    let high = known.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (known[middle]!.time <= time) {
        found = known[middle]!.turn;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found;
  };
  const minGapPercent = railHeight > 0 ? (RAIL_BAR_MIN_GAP_PX / railHeight) * 100 : 0;
  const bars: Array<{ top: number; bookmarks: MessageFollowUp[] }> = [];
  for (const bookmark of ordered) {
    const top = slots <= 1 ? 50 : (turnOf(messageTime(bookmark)) / (slots - 1)) * 100;
    const last = bars.at(-1);
    if (last && top - last.top <= minGapPercent) last.bookmarks.push(bookmark);
    else bars.push({ top, bookmarks: [bookmark] });
  }
  return bars;
}

/** Servers before bookmarks send no `todo`, and every follow-up they hold is a to-do. */
export const isBookmarkTodo = (bookmark: MessageFollowUp) => bookmark.todo ?? true;

export const isOpenBookmarkTodo = (bookmark: MessageFollowUp) =>
  isBookmarkTodo(bookmark) && bookmark.doneAt === null;

/** What a bookmark's menus offer, in order; to-do changes need a server with bookmarks. */
export function bookmarkMenuActions(bookmark: MessageFollowUp): ReadonlyArray<{
  readonly label: string;
  readonly action: MessageFollowUpUpdateInput["action"];
}> {
  const todo = isBookmarkTodo(bookmark);
  return [
    ...(todo
      ? [
          {
            label: bookmark.doneAt ? "Reopen" : "Mark done",
            action: bookmark.doneAt ? "reopen" : "done",
          } as const,
        ]
      : []),
    ...(bookmark.todo === undefined
      ? []
      : [
          {
            label: todo ? "Remove to-do" : "Mark as to-do",
            action: todo ? "untodo" : "todo",
          } as const,
        ]),
    { label: "Remove bookmark", action: "unflag" },
  ];
}

/**
 * What the message row's bookmark or to-do flag button sends for the whole-message bookmark. Both
 * share one record, so a message is unmarked, bookmarked or a to-do: pressing the lit button
 * clears the record, and pressing the other one switches to it.
 */
export function wholeMessageToggle(
  target: Pick<MessageFollowUp, "threadId" | "messageId">,
  whole: MessageFollowUp | null,
  button: "bookmark" | "todo",
): MessageFollowUpUpdateInput {
  if (whole === null) {
    return {
      threadId: target.threadId,
      messageId: target.messageId,
      action: "flag",
      todo: button === "todo",
    };
  }
  const lit = isBookmarkTodo(whole) ? "todo" : "bookmark";
  if (button === lit) return bookmarkUpdate(whole, "unflag");
  return bookmarkUpdate(whole, button === "todo" ? "todo" : "untodo");
}
