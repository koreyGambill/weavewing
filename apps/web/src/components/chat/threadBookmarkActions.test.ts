import { EnvironmentId, MessageId, ThreadId, type MessageFollowUp } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasThreadBookmarks,
  publishThreadBookmarks,
  stepThreadBookmark,
  useThreadBookmarkTrails,
} from "./threadBookmarkActions";

const environmentId = EnvironmentId.make("env");
const bookmark = (id: string): MessageFollowUp => ({
  id,
  threadId: ThreadId.make("thread"),
  threadTitle: "Thread",
  messageId: MessageId.make(id),
  excerpt: id,
  flaggedAt: "2026-01-01T00:00:00.000Z",
  doneAt: null,
});
const step = (threadKey: string, direction: "next" | "previous") =>
  stepThreadBookmark(threadKey, direction)?.bookmark.id;

describe("thread bookmark navigation", () => {
  it("keeps its place when the bookmark list changes under it", () => {
    useThreadBookmarkTrails.setState({}, true);
    const [a, b, c, added] = ["a", "b", "c", "added"].map(bookmark);
    const unpublish = publishThreadBookmarks("t", environmentId, [a!, b!, c!]);
    expect([step("t", "next"), step("t", "next")]).toEqual(["a", "b"]);

    unpublish();
    publishThreadBookmarks("t", environmentId, [added!, a!, b!, c!]);
    expect(step("t", "next")).toBe("c");
    expect(step("t", "previous")).toBe("b");
  });

  it("offers nothing once the thread's rail is gone", () => {
    useThreadBookmarkTrails.setState({}, true);
    const unpublish = publishThreadBookmarks("t", environmentId, [bookmark("a")]);
    expect(hasThreadBookmarks("t")).toBe(true);
    unpublish();
    expect(hasThreadBookmarks("t")).toBe(false);
    expect(step("t", "next")).toBeUndefined();
  });
});
