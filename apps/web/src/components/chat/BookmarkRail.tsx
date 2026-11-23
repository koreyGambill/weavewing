import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MessageFollowUp } from "@t3tools/contracts";
import { useEffect } from "react";

import { cn } from "~/lib/utils";
import { messageFollowUpsUpdate, useMessageFollowUpUpdate } from "../../state/messageFollowUps";
import {
  bookmarkKey,
  bookmarkMenuActions,
  bookmarkRailIndices,
  bookmarkUpdate,
  isBookmarkTodo,
} from "../reviews/bookmarks.logic";
import { Button } from "../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import {
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapTopPercent,
} from "./MessagesTimeline.logic";
import {
  markCurrentThreadBookmark,
  publishThreadBookmarks,
  useThreadBookmarkTrails,
} from "./threadBookmarkActions";

/**
 * Gold bars on the transcript's right edge, one per bookmark, placed beside the left minimap's
 * turn strips. Click a bar to reveal its bookmark; hover it to mark it done or remove it.
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
  const canWrite = useAtomValue(messageFollowUpsUpdate.permissionAtom(environmentId));
  const update = useMessageFollowUpUpdate();
  const jump = (bookmark: MessageFollowUp) => {
    markCurrentThreadBookmark(threadKey, bookmark);
    onJump(bookmark);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- offers this thread's bookmarks to the command palette and shortcuts, which live outside the transcript
  useEffect(
    () => publishThreadBookmarks(threadKey, environmentId, bookmarks),
    [threadKey, environmentId, bookmarks],
  );
  if (bookmarks.length === 0) return null;
  const positions = bookmarkRailIndices(bookmarks, turnTimes);
  const slots = Math.max(1, turnTimes.length);

  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-3 z-40 w-5"
      data-testid="bookmark-rail"
    >
      <div
        className="absolute top-1/2 right-0 w-full -translate-y-1/2"
        style={{ height: resolveTimelineMinimapHeightStyle(slots) }}
      >
        {bookmarks.map((bookmark, index) => {
          const key = bookmarkKey(bookmark);
          const todo = isBookmarkTodo(bookmark);
          const done = todo && bookmark.doneAt !== null;
          const label = `Bookmark ${index + 1} of ${bookmarks.length}`;
          const text = bookmark.excerpt || "Message without text";
          return (
            <PreviewCard key={key}>
              <PreviewCardTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${label}: ${text}`}
                    aria-current={key === currentKey || undefined}
                    className="pointer-events-auto absolute right-0 flex h-2.5 w-full -translate-y-1/2 cursor-pointer items-center justify-end focus-visible:outline-2 focus-visible:outline-ring"
                    style={{
                      top: `calc(${resolveTimelineMinimapTopPercent(positions[index]!.turn, slots)}% + ${positions[index]!.rank * 6}px)`,
                    }}
                    onClick={() => jump(bookmark)}
                  />
                }
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-0.5 rounded-full",
                    key === currentKey ? "w-5" : "w-3.5",
                    done ? "bg-warning/40" : "bg-warning",
                  )}
                />
              </PreviewCardTrigger>
              <PreviewCardPopup side="left" align="center">
                <div className="w-64 p-2 text-xs">
                  <p className="text-muted-foreground">
                    {label}
                    {todo ? (done ? " · done" : " · to-do") : ""}
                  </p>
                  <p className="mt-0.5 line-clamp-3 wrap-anywhere">{text}</p>
                  <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                    {bookmarkMenuActions(bookmark).map(({ label: actionLabel, action }) => (
                      <Button
                        key={action}
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={!canWrite}
                        onClick={() => void update(environmentId, bookmarkUpdate(bookmark, action))}
                      >
                        {actionLabel}
                      </Button>
                    ))}
                  </div>
                </div>
              </PreviewCardPopup>
            </PreviewCard>
          );
        })}
      </div>
    </div>
  );
}
