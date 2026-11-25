import type { MessageFollowUp, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { BookmarkIcon } from "lucide-react";
import { useState } from "react";

import { BookmarkNoteText, BookmarkToggles, useThreadFollowUpList } from "../reviews/FollowUps";
import {
  bookmarkKey,
  bookmarkText,
  isBookmarkTodo,
  orderBookmarks,
} from "../reviews/bookmarks.logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { markCurrentThreadBookmark } from "./threadBookmarkActions";

/** Composer footer list of the thread's bookmarks; a row reveals its bookmark in the transcript. */
export function ChatFooterBookmarks({
  threadRef,
  onReveal,
}: {
  threadRef: ScopedThreadRef | null;
  onReveal: (bookmark: MessageFollowUp) => void;
}) {
  const [open, setOpen] = useState(false);
  const bookmarks = orderBookmarks(useThreadFollowUpList(threadRef));
  if (threadRef === null || bookmarks.length === 0) return null;
  const openTodos = bookmarks.filter((item) => isBookmarkTodo(item) && item.doneAt === null).length;
  const summary = `${bookmarks.length} ${bookmarks.length === 1 ? "bookmark" : "bookmarks"}${
    openTodos > 0 ? `, ${openTodos} open ${openTodos === 1 ? "to-do" : "to-dos"}` : ""
  }`;
  const reveal = (bookmark: MessageFollowUp) => {
    markCurrentThreadBookmark(scopedThreadKey(threadRef), bookmark);
    setOpen(false);
    onReveal(bookmark);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <PopoverTrigger
            render={
              <Button size="compact" variant="ghost-muted" aria-label={`Bookmarks, ${summary}`} />
            }
          >
            <BookmarkIcon />
            <span aria-hidden className="tabular-nums">
              {bookmarks.length}
            </span>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipPopup>{summary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup aria-label="Bookmarks" width="md" padding="none" side="top" align="start">
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
      </PopoverPopup>
    </Popover>
  );
}
