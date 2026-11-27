import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { MessageId } from "./baseSchemas.ts";
import type { ListItem, ThreadQuestion } from "./threadWorkspace.ts";
import {
  questionWaitingItems,
  taskWaitingItems,
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
  it("keeps answer counts exact when answer and task rows share the cap", () => {
    const mirror = waitingMirror(
      [item("task", "T1")],
      Array.from({ length: 40 }, (_, index) => ({
        ref: `A${index + 1}`,
        title: "Tracked question",
        state: index < 31 ? ("answered" as const) : ("owed" as const),
      })),
    );
    expect(mirror.waiting.length + (mirror.waitingAnswers?.length ?? 0)).toBe(30);
    expect(mirror.waitingCounts).toMatchObject({ answer: 31, owed: 9, task: 1, live: 41 });
  });
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

describe("questionWaitingItems", () => {
  const question = (id: string, patch: Partial<ThreadQuestion> = {}): ThreadQuestion => ({
    id,
    prompt: `Should ${id} ship?`,
    options: [],
    recommendedOptionIds: [],
    multiSelect: false,
    state: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    answer: null,
    answeredBy: null,
    replacedBy: null,
    ...patch,
  });
  const message = MessageId.make("message-1");

  it("maps each waiting question with its sent and discussing marks, and user dismissals", () => {
    expect(
      questionWaitingItems({
        questions: [
          question("Q1"),
          question("Q2", { state: "deferred", userChangedAt: "2026-01-02T00:00:00.000Z" }),
          question("Q3", { sentInMessageId: message }),
          question("Q4", { state: "deferred", discussedInMessageId: message }),
          question("Q5", { state: "withdrawn", userChangedAt: "2026-01-02T00:00:00.000Z" }),
          question("Q6", { state: "withdrawn" }),
          question("Q7", { state: "answered" }),
        ],
      }),
    ).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Should Q1 ship?", state: "open" },
      {
        kind: "question",
        ref: "Q2",
        key: "Q2",
        title: "Should Q2 ship?",
        state: "deferred",
        userChangedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        kind: "question",
        ref: "Q3",
        key: "Q3",
        title: "Should Q3 ship?",
        state: "open",
        sent: true,
      },
      {
        kind: "question",
        ref: "Q4",
        key: "Q4",
        title: "Should Q4 ship?",
        state: "discussing",
        deferred: true,
      },
      {
        kind: "question",
        ref: "Q5",
        key: "Q5",
        title: "Should Q5 ship?",
        state: "dismissed",
        settledBy: "user",
        userChangedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });
});

describe("taskWaitingItems", () => {
  const task = (id: string, patch: Partial<ListItem> = {}): ListItem => ({
    id,
    text: `Task ${id}`,
    state: "open",
    owner: "you",
    createdAt: "2026-01-01T00:00:00.000Z",
    doneAt: null,
    details: "",
    parentId: null,
    links: [],
    ref: `T${id}`,
    ...patch,
  });

  it("maps only the user's open tasks, discussing while the user took one into chat", () => {
    expect(
      taskWaitingItems({
        items: [
          task("1"),
          task("2", { discussedInMessageId: MessageId.make("message-1") }),
          task("3", { state: "done" }),
          task("4", { owner: "agent" }),
        ],
      }),
    ).toEqual([
      { kind: "task", ref: "T1", key: "1", title: "Task 1", state: "open" },
      { kind: "task", ref: "T2", key: "2", title: "Task 2", state: "discussing" },
    ]);
  });
});
