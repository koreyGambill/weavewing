import {
  ComposerContextId,
  MessageId,
  type ListItem,
  type ThreadQuestion,
  type WaitingCounts,
  type WaitingItemContextRecord,
  type WaitingItemSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  discussesStillWaiting,
  groupWaitingItems,
  hasLiveQuestions,
  qaKeyParts,
  waitingChipLabel,
  waitingStripSummary,
} from "./waitingStrip.logic";

const item = (
  kind: WaitingItemSummary["kind"],
  ref: string,
  state: WaitingItemSummary["state"] = "open",
): WaitingItemSummary => ({ kind, ref, key: ref, title: ref, state });

const counts = (partial: Partial<WaitingCounts>): WaitingCounts => ({
  question: 0,
  qa: 0,
  task: 0,
  discussing: 0,
  liveQuestions: 0,
  live: 0,
  ...partial,
});

it("includes answered asks in the user total and keeps owed asks visible outside that total", () => {
  expect(waitingStripSummary([], counts({ owed: 2, live: 2 }), 2)).toMatchObject({
    total: 0,
    owedAnswers: 2,
    unlisted: 0,
  });
  expect(waitingStripSummary([], counts({ answer: 3, owed: 4, live: 7 }), 2)).toMatchObject({
    total: 3,
    owedAnswers: 4,
    answersToRead: 3,
    unlisted: 5,
  });
});

describe("waitingStripSummary", () => {
  it("hides the strip when nothing waits on the user and nothing is discussed", () => {
    expect(waitingStripSummary(undefined, undefined)).toBeNull();
    expect(
      waitingStripSummary(
        [item("question", "Q1", "deferred"), item("qa", "QA1", "problem")],
        counts({ liveQuestions: 1, live: 2 }),
      ),
    ).toBeNull();
  });

  it("lists only kinds with items waiting and counts discussions apart", () => {
    expect(
      waitingStripSummary(
        [item("question", "Q1"), item("qa", "QA1", "discussing"), item("task", "T1")],
        counts({ question: 1, task: 1, discussing: 1, liveQuestions: 1, live: 3 }),
      ),
    ).toEqual({
      counts: [
        { kind: "question", count: 1 },
        { kind: "task", count: 1 },
      ],
      discussing: 1,
      total: 2,
      unlisted: 0,
      hasQuestions: true,
    });
  });

  it.each([31, 60])(
    "takes discussions, questions and what is left out from the counts with %i items",
    (size) => {
      // The row lists 30 tasks; a discussed QA change and a deferred question sit past the cap.
      const rows = Array.from({ length: 30 }, (_, index) => item("task", `T${index}`));
      const summary = waitingStripSummary(
        rows,
        counts({ task: size - 2, discussing: 1, liveQuestions: 1, live: size }),
      );
      expect(summary).toMatchObject({
        discussing: 1,
        hasQuestions: true,
        unlisted: size - 30,
        total: size - 2,
      });
    },
  );
});

describe("counts stored before the exact numbers were kept", () => {
  it("derives discussions, questions and the overflow from the rows until the rebuild", () => {
    const rows = [
      item("question", "Q1", "deferred"),
      item("qa", "QA1", "discussing"),
      ...Array.from({ length: 28 }, (_, index) => item("task", `T${index}`)),
    ];
    // As a thread stored before this change decodes: only the per-kind open counts.
    const stored = { question: 0, qa: 0, task: 28 };
    expect(waitingStripSummary(rows, stored)).toEqual({
      counts: [{ kind: "task", count: 28 }],
      discussing: 1,
      total: 28,
      unlisted: 0,
      hasQuestions: true,
    });
    expect(hasLiveQuestions(rows, stored)).toBe(true);
    // A discussion alone keeps the strip, as it did before the numbers existed.
    expect(
      waitingStripSummary([item("qa", "QA1", "discussing")], { question: 0, qa: 0, task: 0 }),
    ).toMatchObject({ discussing: 1, total: 0 });
    // Present numbers win over the rows, even when they are zero.
    expect(hasLiveQuestions(rows, counts({ task: 28, live: 30 }))).toBe(false);
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
    expect(waitingChipLabel(counts({ question: 1, qa: 2 }))).toBe(
      "3 waiting on you: 1 question, 2 changes to check",
    );
  });
});

describe("discussesStillWaiting", () => {
  const reference = (itemKind: WaitingItemContextRecord["itemKind"], key: string) =>
    ({
      version: 1,
      kind: "waiting-item",
      contextId: ComposerContextId.make(`waiting-item_${key.replace(/[^a-z0-9_-]/gi, "-")}`),
      label: key,
      itemKind,
      key,
      ref: key,
      title: key,
    }) satisfies WaitingItemContextRecord;
  const question = (id: string, patch: Partial<ThreadQuestion> = {}) =>
    ({ id, state: "open", ...patch }) as ThreadQuestion;
  const task = (id: string, patch: Partial<ListItem> = {}) =>
    ({ id, owner: "you", state: "open", ...patch }) as ListItem;

  it("drops references to questions and tasks that no longer wait, and keeps QA", () => {
    const records = [
      reference("question", "Q1"),
      reference("question", "Q2"),
      reference("question", "Q3"),
      reference("task", "t1"),
      reference("task", "t2"),
      reference("qa", "landing/change"),
    ];
    expect(
      discussesStillWaiting(records, {
        questions: [
          question("Q1", { state: "deferred" }),
          question("Q2", { state: "answered" }),
          question("Q3", { sentInMessageId: MessageId.make("m") }),
        ],
        items: [task("t1"), task("t2", { state: "done" })],
      })?.map((record) => record.key),
    ).toEqual(["Q1", "t1", "landing/change"]);
    expect(
      discussesStillWaiting([reference("task", "t1")], { questions: [], items: [task("t1")] }),
    ).toBeNull();
  });
});
