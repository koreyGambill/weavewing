import type { MessageFollowUp, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { BookmarkNoteText, BookmarkToggles } from "../reviews/FollowUps";
import { bookmarkKey, bookmarkText, isBookmarkTodo } from "../reviews/bookmarks.logic";
import { markCurrentThreadBookmark } from "./threadBookmarkActions";

/** The summary a bookmark count reads as, such as "3 bookmarks, 1 open to-do". */
export function bookmarkListSummary(bookmarks: ReadonlyArray<MessageFollowUp>): string {
  const openTodos = bookmarks.filter((item) => isBookmarkTodo(item) && item.doneAt === null).length;
  return `${bookmarks.length} ${bookmarks.length === 1 ? "bookmark" : "bookmarks"}${
    openTodos > 0 ? `, ${openTodos} open ${openTodos === 1 ? "to-do" : "to-dos"}` : ""
  }`;
}

/** The thread's bookmarks in order; a row reveals its bookmark in the transcript. */
export function ThreadBookmarkList({
  threadRef,
  bookmarks,
  onReveal,
}: {
  threadRef: ScopedThreadRef;
  bookmarks: ReadonlyArray<MessageFollowUp>;
  onReveal: (bookmark: MessageFollowUp) => void;
}) {
  const reveal = (bookmark: MessageFollowUp) => {
    markCurrentThreadBookmark(scopedThreadKey(threadRef), bookmark);
    onReveal(bookmark);
  };
  return (
    <ul className="max-h-80 overflow-y-auto py-1">
      {bookmarks.map((bookmark) => {
        const todo = isBookmarkTodo(bookmark);
        return (
          <li key={bookmarkKey(bookmark)} className="flex items-start gap-1 px-1.5 py-0.5">
            <button
              type="button"
              className="min-w-0 flex-1 cursor-pointer rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => reveal(bookmark)}
            >
              <span className="block text-muted-foreground">
                {bookmark.role === "user" ? "Prompt" : "Reply"}
                {bookmark.anchor === undefined ? "" : " passage"}
                {todo ? (bookmark.doneAt ? " · done" : " · to-do") : ""}
              </span>
              <span className="line-clamp-2 wrap-anywhere">{bookmarkText(bookmark)}</span>
              {bookmark.note === undefined ? null : (
                <BookmarkNoteText note={bookmark.note} className="mt-0.5" />
              )}
            </button>
            <span className="flex shrink-0 items-center gap-0.5 pt-1">
              <BookmarkToggles
                environmentId={threadRef.environmentId}
                target={bookmark}
                bookmark={bookmark}
                showDone
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
