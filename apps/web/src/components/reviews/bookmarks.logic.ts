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

/** The passage bookmark a selection lands on, so the toolbar can offer to remove it. */
export function findOverlappingBookmark(
  bookmarks: ReadonlyArray<MessageFollowUp>,
  selection: Pick<SideChatAnchor, "messageId" | "start" | "end">,
): MessageFollowUp | null {
  return (
    bookmarks.find(
      (bookmark) =>
        bookmark.anchor !== undefined &&
        bookmark.messageId === selection.messageId &&
        bookmark.anchor.start < selection.end &&
        selection.start < bookmark.anchor.end,
    ) ?? null
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

/**
 * Places each bookmark beside the minimap turn it belongs to. `turnTimes` are the minimap items'
 * times in their order; a bookmark sits at the last turn that started at or before its message,
 * and `rank` counts the bookmarks before it in that turn so the rail can stack them.
 */
export function bookmarkRailIndices(
  ordered: ReadonlyArray<MessageFollowUp>,
  turnTimes: ReadonlyArray<number | null>,
): ReadonlyArray<{ readonly turn: number; readonly rank: number }> {
  const perTurn = new Map<number, number>();
  return ordered.map((bookmark) => {
    const time = messageTime(bookmark);
    let turn = 0;
    for (const [index, turnTime] of turnTimes.entries()) {
      if (turnTime !== null && turnTime <= time) turn = index;
    }
    const seen = perTurn.get(turn) ?? 0;
    perTurn.set(turn, seen + 1);
    return { turn, rank: seen };
  });
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
