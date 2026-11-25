import type { EnvironmentId, MessageFollowUp } from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { BookmarkToggles } from "../reviews/FollowUps";
import {
  bookmarkKey,
  bookmarkRailBars,
  bookmarkText,
  isBookmarkTodo,
} from "../reviews/bookmarks.logic";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { resolveTimelineMinimapHeightStyle } from "./MessagesTimeline.logic";
import {
  markCurrentThreadBookmark,
  publishThreadBookmarks,
  useThreadBookmarkTrails,
} from "./threadBookmarkActions";

const BAR_CLASS =
  "pointer-events-auto absolute right-0 flex h-2.5 w-full -translate-y-1/2 cursor-pointer items-center justify-end gap-1 focus-visible:outline-2 focus-visible:outline-ring";

/**
 * Gold bars on the transcript's right edge, placed beside the left minimap's turn strips. Click a
 * bar to reveal its bookmark; hover it to mark it done or remove it. Bookmarks too close to tell
 * apart share one bar with a count, which opens a chooser.
 */
export function BookmarkRail({
  threadKey,
  environmentId,
  bookmarks,
  turnTimes,
  onJump,
}: {
  threadKey: string;
  environmentId: EnvironmentId;
  /** In transcript order. */
  bookmarks: ReadonlyArray<MessageFollowUp>;
  /** Each left minimap item's time, so bars line up with its strips. */
  turnTimes: ReadonlyArray<number | null>;
  onJump: (bookmark: MessageFollowUp) => void;
}) {
  const currentKey = useThreadBookmarkTrails((trails) => trails[threadKey]?.currentKey ?? null);
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const jump = (bookmark: MessageFollowUp) => {
    markCurrentThreadBookmark(threadKey, bookmark);
    onJump(bookmark);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- offers this thread's bookmarks to the command palette and shortcuts, which live outside the transcript
  useEffect(
    () => publishThreadBookmarks(threadKey, environmentId, bookmarks),
    [threadKey, environmentId, bookmarks],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the rail's rendered height decides which bars are too close to tell apart
  useEffect(() => {
    if (!rail) return;
    return observeResize(rail, () => setRailHeight(rail.clientHeight));
  }, [rail]);
  if (bookmarks.length === 0) return null;
  const slots = Math.max(1, turnTimes.length);
  const bars = bookmarkRailBars(bookmarks, turnTimes, railHeight);
  const ordinal = new Map(bookmarks.map((bookmark, index) => [bookmarkKey(bookmark), index + 1]));
  const label = (bookmark: MessageFollowUp) =>
    `Bookmark ${ordinal.get(bookmarkKey(bookmark))} of ${bookmarks.length}`;

  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-3 z-40 w-5"
      data-testid="bookmark-rail"
    >
      <div
        ref={setRail}
        className="absolute top-1/2 right-0 w-full -translate-y-1/2"
        style={{ height: resolveTimelineMinimapHeightStyle(slots) }}
      >
        {bars.map((bar) => {
          const first = bar.bookmarks[0]!;
          const current = bar.bookmarks.some((bookmark) => bookmarkKey(bookmark) === currentKey);
          const allDone = bar.bookmarks.every(
            (bookmark) => isBookmarkTodo(bookmark) && bookmark.doneAt !== null,
          );
          const mark = (
            <span
              aria-hidden="true"
              className={cn(
                "h-0.5 rounded-full",
                current ? "w-5" : "w-3.5",
                allDone ? "bg-warning/40" : "bg-warning",
              )}
            />
          );
          if (bar.bookmarks.length > 1) {
            return (
              <Menu key={bookmarkKey(first)}>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${bar.bookmarks.length} bookmarks here`}
                      aria-current={current || undefined}
                      className={BAR_CLASS}
                      style={{ top: `${bar.top}%` }}
                    />
                  }
                >
                  <span className="text-3xs leading-none font-medium text-warning tabular-nums">
                    {bar.bookmarks.length}
                  </span>
                  {mark}
                </MenuTrigger>
                <MenuPopup side="left" align="center">
                  {bar.bookmarks.map((bookmark) => (
                    <MenuItem key={bookmarkKey(bookmark)} onClick={() => jump(bookmark)}>
                      <span className="block max-w-64 truncate">
                        {label(bookmark)}: {bookmarkText(bookmark)}
                      </span>
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            );
          }
          return (
            <BookmarkRailBarCard
              key={bookmarkKey(first)}
              environmentId={environmentId}
              bookmark={first}
              label={label(first)}
              top={bar.top}
              current={current}
              onJump={() => jump(first)}
            >
              {mark}
            </BookmarkRailBarCard>
          );
        })}
      </div>
    </div>
  );
}

function BookmarkRailBarCard({
  environmentId,
  bookmark,
  label,
  top,
  current,
  onJump,
  children,
}: {
  environmentId: EnvironmentId;
  bookmark: MessageFollowUp;
  label: string;
  top: number;
  current: boolean;
  onJump: () => void;
  children: ReactNode;
}) {
  const todo = isBookmarkTodo(bookmark);
  const done = todo && bookmark.doneAt !== null;
  const text = bookmarkText(bookmark);
  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${text}`}
            aria-current={current || undefined}
            className={BAR_CLASS}
            style={{ top: `${top}%` }}
            onClick={onJump}
          />
        }
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup side="left" align="center">
        <div className="w-64 p-2 text-xs">
          <p className="text-muted-foreground">
            {label}
            {todo ? (done ? " · done" : " · to-do") : ""}
          </p>
          <p className="mt-0.5 line-clamp-3 wrap-anywhere">{text}</p>
          <div className="mt-1.5 flex justify-end gap-0.5">
            <BookmarkToggles
              environmentId={environmentId}
              target={bookmark}
              bookmark={bookmark}
              showDone
            />
          </div>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
