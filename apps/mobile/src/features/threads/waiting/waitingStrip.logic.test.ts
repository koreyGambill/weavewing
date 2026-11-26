import type { WaitingCounts, WaitingItemSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWaitingRows,
  waitingBadgeLabel,
  qaKeyParts,
  waitingCountsPhrase,
  waitingSummary,
} from "./waitingStrip.logic";

const row = (overrides: Partial<WaitingItemSummary> & Pick<WaitingItemSummary, "kind" | "ref">) =>
  ({
    key: overrides.ref,
    title: `Title ${overrides.ref}`,
    state: "open",
    ...overrides,
  }) as WaitingItemSummary;

const counts = (overrides: Partial<WaitingCounts>): WaitingCounts => ({
  question: 0,
  qa: 0,
  task: 0,
  ...overrides,
});

describe("waitingSummary", () => {
  it("hides when nothing waits and nothing is discussed", () => {
    expect(waitingSummary(undefined, undefined)).toBeNull();
    expect(waitingSummary([], counts({ discussing: 0, live: 0 }))).toBeNull();
  });

  it("counts one item", () => {
    expect(waitingSummary([row({ kind: "qa", ref: "QA1" })], counts({ qa: 1, live: 1 }))).toEqual({
      counts: [{ kind: "qa", count: 1 }],
      discussing: 0,
      total: 1,
      unlisted: 0,
    });
  });

  it("takes counts from waitingCounts when the rows are capped", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      row({ kind: "qa", ref: `QA${index + 1}` }),
    );
    const summary = waitingSummary(rows, counts({ question: 2, qa: 43, discussing: 1, live: 46 }));
    expect(summary?.counts).toEqual([
      { kind: "question", count: 2 },
      { kind: "qa", count: 43 },
    ]);
    expect(summary?.total).toBe(45);
    expect(summary?.unlisted).toBe(16);
  });

  it("falls back to the rows for discussing and claims nothing unlisted when an older server omits them", () => {
    const rows = [
      row({ kind: "task", ref: "T1" }),
      row({ kind: "qa", ref: "QA1", state: "discussing" }),
      row({ kind: "qa", ref: "QA2", state: "settled" }),
    ];
    expect(waitingSummary(rows, counts({ task: 1 }))).toEqual({
      counts: [{ kind: "task", count: 1 }],
      discussing: 1,
      total: 1,
      unlisted: 0,
    });
    // Only a discussion remains, so the strip still shows.
    expect(waitingSummary(rows.slice(1), counts({}))?.discussing).toBe(1);
  });
});

describe("groupWaitingRows", () => {
  it("groups still-waiting rows by kind in strip order and drops closed ones", () => {
    const groups = groupWaitingRows([
      row({ kind: "task", ref: "T1" }),
      row({ kind: "qa", ref: "QA1", state: "problem" }),
      row({ kind: "question", ref: "Q1", state: "dismissed" }),
      row({ kind: "question", ref: "Q2", state: "deferred" }),
    ]);
    expect(groups.map((group) => [group.kind, group.items.map((item) => item.ref)])).toEqual([
      ["question", ["Q2"]],
      ["qa", ["QA1"]],
      ["task", ["T1"]],
    ]);
  });
});

it("phrases counts per kind and speaks nothing for a row with none waiting", () => {
  expect(waitingCountsPhrase(counts({ question: 1, task: 2 }))).toBe("1 question, 2 tasks");
  expect(waitingBadgeLabel(counts({ qa: 2 }))).toBe("2 waiting on you: 2 changes to check");
  expect(waitingBadgeLabel(counts({ discussing: 1 }))).toBeNull();
  expect(waitingBadgeLabel(undefined)).toBeNull();
});

it("splits a QA key and rejects one without a change id", () => {
  expect(qaKeyParts("landing-1/change-a")).toEqual({
    landingId: "landing-1",
    changeId: "change-a",
  });
  expect(qaKeyParts("landing-1/")).toBeNull();
  expect(qaKeyParts("landing-1")).toBeNull();
});
