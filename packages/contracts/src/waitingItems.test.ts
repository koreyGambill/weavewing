import { describe, expect, it } from "vite-plus/test";

import {
  WAITING_ITEMS_LIMIT,
  waitingMirror,
  type WaitingItemState,
  type WaitingItemSummary,
} from "./waitingItems.ts";

const item = (
  kind: WaitingItemSummary["kind"],
  ref: string,
  state: WaitingItemState = "open",
  extra: Partial<WaitingItemSummary> = {},
): WaitingItemSummary => ({ kind, ref, key: ref, title: ref, state, ...extra });

describe("waitingMirror", () => {
  it("counts only open items nobody has sent an answer for", () => {
    const { waitingCounts } = waitingMirror([
      item("question", "Q1"),
      item("question", "Q2", "deferred"),
      item("question", "Q3", "open", { sent: true }),
      item("question", "Q4", "discussing"),
      item("question", "Q5", "dismissed", { userChangedAt: "2026-11-20T12:00:00.000Z" }),
      item("qa", "QA1"),
      item("qa", "QA2", "problem"),
      item("qa", "QA3", "discussing"),
      item("task", "T1"),
      item("task", "T2", "settled"),
    ]);
    expect(waitingCounts).toEqual({ question: 1, qa: 1, task: 1 });
  });

  it("groups by kind and keeps closed items after the waiting ones", () => {
    const { waiting } = waitingMirror([
      item("task", "T1"),
      item("question", "Q2", "dismissed", { userChangedAt: "2026-11-20T12:00:00.000Z" }),
      item("qa", "QA1"),
      item("question", "Q1"),
    ]);
    expect(waiting.map((entry) => entry.ref)).toEqual(["Q1", "QA1", "T1", "Q2"]);
  });

  it("caps the list, keeping what waits on the user first, with exact counts", () => {
    const items = [
      item("question", "Q0", "deferred"),
      item("qa", "QA0", "problem"),
      ...Array.from({ length: WAITING_ITEMS_LIMIT + 4 }, (_, index) => item("task", `T${index}`)),
    ];
    const { waiting, waitingCounts } = waitingMirror(items);
    expect(waiting).toHaveLength(WAITING_ITEMS_LIMIT);
    expect(waiting.every((entry) => entry.kind === "task")).toBe(true);
    expect(waitingCounts).toEqual({ question: 0, qa: 0, task: WAITING_ITEMS_LIMIT + 4 });
  });
});
