import type { ThreadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sectionThreadQuestions, threadQuestionCounts } from "./threadQuestions.ts";

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
  recommendedOptionIds: [],
  multiSelect: false,
  state,
  createdAt: "2026-09-04T12:00:00.000Z",
  closedAt: null,
  answer: null,
  answeredBy: null,
  replacedBy: null,
  ...extra,
});
const draft = (chosenOptionIds: string[], notes = "") => ({
  chosenOptionIds,
  notes,
  submittedAt: null,
});

describe("thread questions", () => {
  it("sections waiting and deferred in asked order and closed newest first", () => {
    const sections = sectionThreadQuestions([
      question("Q1", "answered", { closedAt: "2026-09-04T12:01:00.000Z" }),
      question("Q2", "open"),
      question("Q3", "deferred"),
      question("Q4", "withdrawn", { closedAt: "2026-09-04T12:05:00.000Z" }),
      question("Q5", "open"),
      question("Q6", "replaced", { closedAt: "2026-09-04T12:03:00.000Z" }),
    ]);
    expect({
      waiting: sections.waiting.map((entry) => entry.id),
      deferred: sections.deferred.map((entry) => entry.id),
      closed: sections.closed.map((entry) => entry.id),
    }).toEqual({ waiting: ["Q2", "Q5"], deferred: ["Q3"], closed: ["Q4", "Q6", "Q1"] });
  });

  it("counts only open questions as waiting and only unsent choices or notes as drafts", () => {
    expect(
      threadQuestionCounts([
        question("Q1", "open", { answer: draft(["a"]) }),
        question("Q2", "open", { answer: draft([], "  ") }),
        question("Q3", "deferred", { answer: draft([], "later") }),
        question("Q4", "answered", { answer: draft(["b"]) }),
        question("Q5", "open", {
          answer: { ...draft(["a"]), submittedAt: "2026-09-04T12:00:00.000Z" },
        }),
      ]),
    ).toEqual({ waiting: 3, deferred: 1, drafted: 2 });
  });
});
