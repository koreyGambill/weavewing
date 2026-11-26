import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WAITING_ITEMS_LIMIT,
  WaitingCounts,
  waitingDisplayRows,
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
  it("counts only open items nobody has sent an answer for, and keeps the rest exact", () => {
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
    expect(waitingCounts).toEqual({
      question: 1,
      qa: 1,
      task: 1,
      discussing: 2,
      liveQuestions: 4,
      live: 8,
    });
  });

  it("groups by kind and keeps closed questions the user changed", () => {
    const { waiting } = waitingMirror([
      item("task", "T1"),
      item("question", "Q2", "dismissed", { userChangedAt: "2026-11-20T12:00:00.000Z" }),
      item("qa", "QA1"),
      item("question", "Q1"),
    ]);
    expect(waiting.map((entry) => entry.ref)).toEqual(["Q2", "Q1", "QA1", "T1"]);
  });

  it("keeps every question and caps the other kinds, with exact counts", () => {
    const items = [
      item("question", "Q0", "deferred"),
      item("question", "Q1", "discussing"),
      item("question", "Q2", "open", { sent: true }),
      item("qa", "QA0", "problem"),
      ...Array.from({ length: WAITING_ITEMS_LIMIT + 4 }, (_, index) => item("task", `T${index}`)),
    ];
    const { waiting, waitingCounts } = waitingMirror(items);
    expect(waiting.filter((entry) => entry.kind === "question")).toHaveLength(3);
    expect(waiting.filter((entry) => entry.kind !== "question")).toHaveLength(WAITING_ITEMS_LIMIT);
    expect(waiting.some((entry) => entry.ref === "QA0")).toBe(false);
    expect(waitingCounts).toMatchObject({
      task: WAITING_ITEMS_LIMIT + 4,
      discussing: 1,
      liveQuestions: 3,
      live: WAITING_ITEMS_LIMIT + 8,
    });
  });
});

const decodeCounts = Schema.decodeUnknownSync(WaitingCounts);

describe("WaitingCounts", () => {
  it("reads counts stored before the exact numbers were kept as missing, not zero", () => {
    expect(decodeCounts({ question: 1, qa: 0, task: 2 })).toEqual({
      question: 1,
      qa: 0,
      task: 2,
    });
  });
});

describe("waitingDisplayRows", () => {
  it("lists at most the limit, preferring what waits on the user, grouped by kind", () => {
    const rows = waitingDisplayRows([
      item("question", "Q0", "deferred"),
      item("question", "Q9", "dismissed", { userChangedAt: "2026-11-20T12:00:00.000Z" }),
      ...Array.from({ length: WAITING_ITEMS_LIMIT }, (_, index) => item("task", `T${index}`)),
    ]);
    expect(rows).toHaveLength(WAITING_ITEMS_LIMIT);
    expect(rows.every((row) => row.kind === "task")).toBe(true);
  });
});
