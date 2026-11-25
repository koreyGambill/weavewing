import type { EnvironmentId, MessageFollowUp } from "@t3tools/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";

import { BookmarkCardBody } from "../reviews/FollowUps";
import { bookmarkKey } from "../reviews/bookmarks.logic";
import { Popover, PopoverPopup } from "../ui/popover";

export interface PlacedPassage {
  readonly bookmark: MessageFollowUp;
  readonly range: Range;
}

/** Leaving the text for the card crosses a gap, so closing waits this long. */
const CLOSE_DELAY_MS = 200;

const hitPassage = (placed: ReadonlyArray<PlacedPassage>, x: number, y: number) =>
  placed.find(({ range }) =>
    Array.from(range.getClientRects()).some(
      (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
    ),
  ) ?? null;

/**
 * Opens a bookmark's toggles while the pointer rests on its tinted passage. The tint is a CSS
 * highlight with no element to hover, so the pointer is hit-tested against the passage's ranges.
 */
export function BookmarkPassageHover({
  environmentId,
  rootRef,
  placedRef,
  bookmarks,
}: {
  environmentId: EnvironmentId;
  rootRef: RefObject<HTMLElement | null>;
  placedRef: RefObject<ReadonlyArray<PlacedPassage>>;
  bookmarks: ReadonlyArray<MessageFollowUp>;
}) {
  const [hovered, setHovered] = useState<{
    key: string;
    range: Range;
    root: HTMLElement;
  } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHovered(null), CLOSE_DELAY_MS);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to pointer movement over the message's DOM, which has no element per passage
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const move = (event: PointerEvent) => {
      // A pressed button is a selection in progress; touch has no hover.
      if (event.pointerType !== "mouse" || event.buttons !== 0) return;
      const hit = hitPassage(placedRef.current, event.clientX, event.clientY);
      if (!hit) {
        if (closeTimer.current === null) scheduleClose();
        return;
      }
      cancelClose();
      const key = bookmarkKey(hit.bookmark);
      setHovered((current) => (current?.key === key ? current : { key, range: hit.range, root }));
    };
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", scheduleClose);
    return () => {
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", scheduleClose);
      cancelClose();
    };
  });
  const bookmark = hovered && bookmarks.find((item) => bookmarkKey(item) === hovered.key);
  if (!hovered || !bookmark) return null;
  return (
    <Popover open onOpenChange={(open) => (open ? undefined : setHovered(null))}>
      <PopoverPopup
        aria-label="Bookmarked passage"
        padding="none"
        side="top"
        anchor={{
          getBoundingClientRect: () => hovered.range.getBoundingClientRect(),
          contextElement: hovered.root,
        }}
        initialFocus={false}
        finalFocus={false}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
      >
        <BookmarkCardBody
          environmentId={environmentId}
          bookmark={bookmark}
          title={bookmark.anchor === undefined ? "Bookmark" : "Bookmarked passage"}
        />
      </PopoverPopup>
    </Popover>
  );
}
