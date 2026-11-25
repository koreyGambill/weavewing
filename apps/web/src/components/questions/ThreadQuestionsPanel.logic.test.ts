import type { ThreadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
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
  ]);

  it("lists waiting, then deferred, then closed, and keeps a selection while it exists", () => {
    expect(order.map((entry) => entry.id)).toEqual(["Q3", "Q4", "Q2", "Q1"]);
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
    ["Escape", "Q3", { type: "close" }],
    ["x", "Q3", null],
  ] as const)("maps %s on %s", (key, selectedId, action) => {
    expect(questionPanelKeyAction({ key, order, selectedId })).toEqual(action);
  });
});
