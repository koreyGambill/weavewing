import type { ThreadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  questionInView,
  questionPanelKeyAction,
  questionPanelOrder,
  resolveSelectedQuestionId,
} from "./ThreadQuestionsPanel.logic";

const question = (
  id: string,
  state: ThreadQuestion["state"],
  extra: Partial<ThreadQuestion> = {},
): ThreadQuestion => ({
  id,
  prompt: `Prompt ${id}`,
  options: [
    { id: "a", label: "Alpha", description: "" },
    { id: "b", label: "Beta", description: "" },
  ],
  recommendedOptionIds: ["a"],
  multiSelect: false,
  state,
  createdAt: "2026-09-04T12:00:00.000Z",
  closedAt: state === "open" || state === "deferred" ? null : "2026-09-04T12:10:00.000Z",
  answer: null,
  answeredBy: null,
  replacedBy: null,
  ...extra,
});

describe("question panel", () => {
  const order = questionPanelOrder([
    question("Q1", "answered"),
    question("Q2", "deferred"),
    question("Q3", "open"),
    question("Q4", "open", {
      multiSelect: true,
      answer: { chosenOptionIds: ["a"], notes: "", submittedAt: null },
    }),
    question("Q5", "open", {
      answer: { chosenOptionIds: ["a"], notes: "", submittedAt: null },
    }),
    question("Q6", "open", {
      answer: { chosenOptionIds: ["a"], notes: "", submittedAt: null },
      sentInMessageId: "message-1" as ThreadQuestion["sentInMessageId"],
    }),
  ]);

  it("lists waiting, then deferred, then closed, and keeps a selection while it exists", () => {
    expect(order.map((entry) => entry.id)).toEqual(["Q3", "Q4", "Q5", "Q6", "Q2", "Q1"]);
    expect(resolveSelectedQuestionId(order, "Q2")).toBe("Q2");
    expect(resolveSelectedQuestionId(order, "Q9")).toBe("Q3");
    expect(resolveSelectedQuestionId([], null)).toBeNull();
  });

  it.each([
    ["j", "Q3", { type: "select", id: "Q4" }],
    ["k", "Q4", { type: "select", id: "Q3" }],
    ["k", "Q3", null],
    ["J", "Q1", null],
    ["j", null, { type: "select", id: "Q3" }],
    ["2", "Q3", { type: "choose", id: "Q3", chosenOptionIds: ["b"] }],
    // A multi-select toggles; the recommendation is never chosen for the user.
    ["2", "Q4", { type: "choose", id: "Q4", chosenOptionIds: ["a", "b"] }],
    ["1", "Q4", { type: "choose", id: "Q4", chosenOptionIds: [] }],
    ["3", "Q3", null],
    ["1", "Q2", { type: "choose", id: "Q2", chosenOptionIds: ["a"] }],
    ["1", "Q1", null],
    ["n", "Q3", { type: "defer", id: "Q3" }],
    ["n", "Q2", null],
    // Choosing the chosen option again clears it, single-select included.
    ["1", "Q5", { type: "choose", id: "Q5", chosenOptionIds: [] }],
    ["2", "Q5", { type: "choose", id: "Q5", chosenOptionIds: ["b"] }],
    // A sent answer is read-only until its message is edited or cancelled.
    ["1", "Q6", null],
    ["n", "Q6", null],
    ["Escape", "Q3", { type: "close" }],
    ["x", "Q3", null],
  ] as const)("maps %s on %s", (key, selectedId, action) => {
    expect(questionPanelKeyAction({ key, order, selectedId })).toEqual(action);
  });

  it("follows the scroll to the first card in view, keeping a focused card that still shows", () => {
    const cards = [
      { id: "Q1", top: -300, bottom: -10 },
      { id: "Q2", top: -10, bottom: 200 },
      { id: "Q3", top: 200, bottom: 400 },
      { id: "Q4", top: 400, bottom: 560 },
    ];
    const view = { top: 0, bottom: 500 };
    expect(questionInView(cards, view, null)).toBe("Q2");
    expect(questionInView(cards, view, "Q1")).toBe("Q2");
    // Jumped to near the end, where the column cannot scroll it to the top.
    expect(questionInView(cards, view, "Q4")).toBe("Q4");
    expect(questionInView([], view, "Q4")).toBeNull();
  });
});
