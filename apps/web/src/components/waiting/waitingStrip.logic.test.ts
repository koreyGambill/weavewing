import type { WaitingItemSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWaitingItems,
  qaKeyParts,
  waitingChipLabel,
  waitingStripSummary,
} from "./waitingStrip.logic";

const item = (
  kind: WaitingItemSummary["kind"],
  ref: string,
  state: WaitingItemSummary["state"] = "open",
): WaitingItemSummary => ({ kind, ref, key: ref, title: ref, state });

describe("waitingStripSummary", () => {
  it("hides the strip when nothing waits on the user and nothing is discussed", () => {
    expect(waitingStripSummary(undefined, undefined)).toBeNull();
    expect(
      waitingStripSummary([item("question", "Q1", "deferred"), item("qa", "QA1", "problem")], {
        question: 0,
        qa: 0,
        task: 0,
      }),
    ).toBeNull();
  });

  it("lists only kinds with items waiting and counts discussions apart", () => {
    expect(
      waitingStripSummary(
        [item("question", "Q1"), item("qa", "QA1", "discussing"), item("task", "T1")],
        { question: 1, qa: 0, task: 1 },
      ),
    ).toEqual({
      counts: [
        { kind: "question", count: 1 },
        { kind: "task", count: 1 },
      ],
      discussing: 1,
      total: 2,
    });
    expect(
      waitingStripSummary([item("task", "T1", "discussing")], { question: 0, qa: 0, task: 0 }),
    ).toEqual({ counts: [], discussing: 1, total: 0 });
  });
});

describe("groupWaitingItems", () => {
  it("groups still-waiting items as questions, QA, then tasks, leaving closed ones out", () => {
    expect(
      groupWaitingItems([
        item("task", "T1"),
        item("question", "Q2", "dismissed"),
        item("qa", "QA1", "problem"),
        item("question", "Q1", "deferred"),
      ]).map((group) => [group.kind, group.items.map((entry) => entry.ref)]),
    ).toEqual([
      ["question", ["Q1"]],
      ["qa", ["QA1"]],
      ["task", ["T1"]],
    ]);
  });
});

describe("qaKeyParts", () => {
  it("splits a QA key and refuses one without both parts", () => {
    expect(qaKeyParts("landing-1/toast-count")).toEqual({
      landingId: "landing-1",
      changeId: "toast-count",
    });
    expect(qaKeyParts("landing-1")).toBeNull();
    expect(qaKeyParts("/toast")).toBeNull();
    expect(qaKeyParts("landing-1/")).toBeNull();
  });
});

describe("waitingChipLabel", () => {
  it("names each kind with a count", () => {
    expect(waitingChipLabel({ question: 1, qa: 2, task: 0 })).toBe(
      "3 waiting on you: 1 question, 2 changes to check",
    );
  });
});
