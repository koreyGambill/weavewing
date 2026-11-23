import { EnvironmentId, MessageId, ThreadId, type MessageFollowUp } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  adjacentBookmark,
  bookmarkKey,
  bookmarkMenuActions,
  bookmarkNavigation,
  bookmarkRailIndices,
  bookmarkUpdate,
  findOverlappingBookmark,
  orderBookmarks,
} from "./bookmarks.logic";

const threadId = ThreadId.make("thread");
const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

function bookmark(
  id: string,
  messageId: string,
  messageMinute: number,
  passage?: { readonly start: number; readonly text: string },
): MessageFollowUp {
  return {
    id,
    threadId,
    threadTitle: "Thread",
    messageId: MessageId.make(messageId),
    role: "assistant",
    messageCreatedAt: at(messageMinute),
    excerpt: passage?.text ?? "",
    flaggedAt: at(59),
    doneAt: null,
    ...(passage
      ? {
          anchor: {
            messageId: MessageId.make(messageId),
            text: passage.text,
            start: passage.start,
            end: passage.start + passage.text.length,
            prefix: "",
            suffix: "",
          },
        }
      : {}),
  };
}

const laterPassage = bookmark("later-passage", "reply", 5, { start: 40, text: "second" });
const earlierPassage = bookmark("earlier-passage", "reply", 5, { start: 3, text: "first" });
const wholeReply = bookmark("whole-reply", "reply", 5);
const prompt = bookmark("prompt", "prompt", 1);
const ordered = orderBookmarks([laterPassage, earlierPassage, wholeReply, prompt]);

describe("orderBookmarks", () => {
  it("orders by message, then the whole message before its passages in text order", () => {
    expect(ordered.map(bookmarkKey)).toEqual([
      "prompt",
      "whole-reply",
      "earlier-passage",
      "later-passage",
    ]);
  });

  it("falls back to when a bookmark was made for servers that send no message time", () => {
    const { messageCreatedAt: _, ...old } = { ...prompt, flaggedAt: at(30) };
    expect(orderBookmarks([old, wholeReply]).map(bookmarkKey)).toEqual(["whole-reply", "prompt"]);
  });
});

describe("adjacentBookmark", () => {
  it("starts at an end, steps, and wraps both ways", () => {
    expect(adjacentBookmark(ordered, null, "next")?.id).toBe("prompt");
    expect(adjacentBookmark(ordered, null, "previous")?.id).toBe("later-passage");
    expect(adjacentBookmark(ordered, "whole-reply", "next")?.id).toBe("earlier-passage");
    expect(adjacentBookmark(ordered, "later-passage", "next")?.id).toBe("prompt");
    expect(adjacentBookmark(ordered, "prompt", "previous")?.id).toBe("later-passage");
    expect(adjacentBookmark([], null, "next")).toBeNull();
  });

  it("restarts at an end when the current bookmark was removed", () => {
    expect(adjacentBookmark(ordered, "gone", "previous")?.id).toBe("later-passage");
  });
});

describe("findOverlappingBookmark", () => {
  it("finds a passage the selection touches in the same message only", () => {
    const messageId = MessageId.make("reply");
    expect(findOverlappingBookmark(ordered, { messageId, start: 6, end: 12 })?.id).toBe(
      "earlier-passage",
    );
    expect(findOverlappingBookmark(ordered, { messageId, start: 8, end: 40 })).toBeNull();
    expect(
      findOverlappingBookmark(ordered, { messageId: MessageId.make("prompt"), start: 0, end: 50 }),
    ).toBeNull();
  });
});

describe("bookmarkUpdate", () => {
  it("names the bookmark when the server gave it an id, else its whole message", () => {
    expect(bookmarkUpdate(earlierPassage, "unflag")).toEqual({
      threadId,
      messageId: "reply",
      action: "unflag",
      bookmarkId: "earlier-passage",
    });
    const { id: _, ...legacy } = prompt;
    expect(bookmarkUpdate(legacy, "done")).toEqual({
      threadId,
      messageId: "prompt",
      action: "done",
    });
  });
});

describe("bookmarkNavigation", () => {
  const environmentId = EnvironmentId.make("env");

  it("reveals a whole message, or quotes a passage so it is highlighted", () => {
    expect(bookmarkNavigation(environmentId, wholeReply).hash).toMatch(/^message=/);
    expect(bookmarkNavigation(environmentId, earlierPassage).hash).toMatch(/^assistant-citation=/);
  });
});

describe("bookmarkRailIndices", () => {
  it("lines bookmarks up with the turn they fall in, stepping down within a turn", () => {
    const turns = [Date.parse(at(0)), Date.parse(at(4)), Date.parse(at(9))];
    expect(bookmarkRailIndices(ordered, turns)).toEqual([
      { turn: 0, rank: 0 },
      { turn: 1, rank: 0 },
      { turn: 1, rank: 1 },
      { turn: 1, rank: 2 },
    ]);
  });

  it("puts bookmarks before the first known turn at the top", () => {
    expect(bookmarkRailIndices([prompt], [null, Date.parse(at(3))])).toEqual([
      { turn: 0, rank: 0 },
    ]);
  });
});

describe("bookmarkMenuActions", () => {
  const labels = (item: MessageFollowUp) => bookmarkMenuActions(item).map(({ label }) => label);

  it("offers done states only to to-dos, and to-do changes only where the server has them", () => {
    expect(labels({ ...prompt, todo: false })).toEqual(["Mark as to-do", "Remove bookmark"]);
    expect(labels({ ...prompt, todo: true })).toEqual([
      "Mark done",
      "Remove to-do",
      "Remove bookmark",
    ]);
    expect(labels({ ...prompt, todo: true, doneAt: at(9) })[0]).toBe("Reopen");
    const { todo: _, ...legacy } = prompt;
    expect(labels(legacy)).toEqual(["Mark done", "Remove bookmark"]);
  });
});
