import type { ThreadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { closedQuestionOutcome, closedQuestionShownAnswer } from "./ThreadQuestionCard.logic";

const question = (state: ThreadQuestion["state"], extra: Partial<ThreadQuestion> = {}) => ({
  state,
  options: [
    { id: "a", label: "Exclude skills", description: "" },
    { id: "b", label: "Keep them", description: "" },
  ],
  answer: null,
  replacedBy: null,
  ...extra,
});
const answer = (chosenOptionIds: string[], notes = "") => ({
  chosenOptionIds,
  notes,
  submittedAt: "2026-11-24T12:00:00.000Z",
});

describe("closedQuestionOutcome", () => {
  it.each([
    ["an open question keeps its card", question("open"), null],
    ["a deferred question keeps its card", question("deferred", { answer: answer(["a"]) }), null],
    ["a choice", question("answered", { answer: answer(["a"]) }), "Exclude skills"],
    [
      "a choice and its note",
      question("answered", { answer: answer(["a", "b"], " check X ") }),
      "Exclude skills, Keep them · “check X”",
    ],
    ["a note alone", question("answered", { answer: answer([], "later") }), "“later”"],
    ["an answer with nothing recorded", question("answered"), "Answered"],
    // The badge says Dismissed, so the line does not repeat it.
    ["a dismissal", question("withdrawn", { answer: answer(["a"]) }), ""],
    // Its link to the replacement, in the badge's place, says Replaced by Q7.
    ["a replacement", question("replaced", { replacedBy: "Q7" }), ""],
    ["a replacement whose successor is unknown", question("replaced"), ""],
  ] as const)("shows %s", (_name, entry, outcome) => {
    expect(closedQuestionOutcome(entry)).toBe(outcome);
  });
});

describe("closedQuestionShownAnswer", () => {
  it.each([
    [
      "an answer's choice and trimmed note",
      question("answered", { answer: answer(["b"], " check X ") }),
      { chosenOptionIds: ["b"], notes: "check X" },
    ],
    ["an answer with nothing recorded", question("answered"), { chosenOptionIds: [], notes: "" }],
    // A draft left on a dismissed question was never sent, so it is not shown as the answer.
    [
      "no draft on a dismissal",
      question("withdrawn", { answer: answer(["a"], "maybe") }),
      { chosenOptionIds: [], notes: "" },
    ],
    [
      "no draft on a replacement",
      question("replaced", { replacedBy: "Q7", answer: answer(["a"]) }),
      { chosenOptionIds: [], notes: "" },
    ],
  ] as const)("shows %s", (_name, entry, shown) => {
    expect(closedQuestionShownAnswer(entry)).toEqual(shown);
  });
});
