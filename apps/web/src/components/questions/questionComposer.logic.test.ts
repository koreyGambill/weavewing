import type { ThreadQuestion, ThreadWorkspace } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { draftedAnswersForComposer, questionAnswerForComposer } from "./questionComposer.logic";

const question = (answer: ThreadQuestion["answer"], extra: Partial<ThreadQuestion> = {}) =>
  ({
    id: "Q1",
    prompt: "Which database?",
    options: [
      { id: "pg", label: "Postgres", description: "" },
      { id: "lite", label: "SQLite", description: "" },
    ],
    recommendedOptionIds: [],
    multiSelect: false,
    state: "open",
    createdAt: "2026-09-04T12:00:00.000Z",
    closedAt: null,
    answer,
    answeredBy: null,
    replacedBy: null,
    ...extra,
  }) satisfies ThreadQuestion;
const draft = (chosenOptionIds: string[], draftRevision: number) => ({
  chosenOptionIds,
  notes: "",
  submittedAt: null,
  draftRevision,
});
const workspace = (questions: ThreadQuestion[], revision = 1) =>
  ({ questions, revision }) as unknown as ThreadWorkspace;

describe("questionAnswerForComposer", () => {
  it("takes the draft the newest save returned over the one the card rendered", () => {
    const shown = question(draft(["pg"], 2));
    const result = questionAnswerForComposer("t1", shown, {
      saved: workspace([question(draft(["lite"], 5))]),
    });
    expect(result).toMatchObject({ choice: "SQLite", answerRevision: 5 });
  });

  it("uses the rendered draft when nothing was written since", () => {
    expect(
      questionAnswerForComposer("t1", question(draft(["pg"], 2)), { saved: null }),
    ).toMatchObject({ choice: "Postgres", answerRevision: 2 });
  });

  it("adds nothing when the save failed or the draft is empty", () => {
    expect(questionAnswerForComposer("t1", question(draft(["pg"], 2)), null)).toBeNull();
    expect(
      questionAnswerForComposer("t1", question(draft(["pg"], 2)), {
        saved: workspace([question(draft([], 6))]),
      }),
    ).toBeNull();
    expect(questionAnswerForComposer("t1", question(null), { saved: null })).toBeNull();
  });
});

describe("draftedAnswersForComposer", () => {
  const open = (
    id: string,
    answer: ThreadQuestion["answer"],
    extra: Partial<ThreadQuestion> = {},
  ) => question(answer, { id, prompt: `Prompt ${id}`, ...extra });

  it("queues every unsent draft from the newer of the shown and saved workspaces", () => {
    const shown = workspace([open("Q1", draft(["pg"], 2)), open("Q2", null)], 4);
    const saved = workspace(
      [
        open("Q1", draft(["lite"], 5)),
        open("Q2", { ...draft([], 5), notes: "typed" }),
        open("Q3", draft(["pg"], 3), {
          sentInMessageId: "m1" as ThreadQuestion["sentInMessageId"],
        }),
        open("Q4", draft(["pg"], 3), { state: "withdrawn" }),
      ],
      5,
    );
    expect(
      draftedAnswersForComposer("t1", shown, { saved })?.map((record) => [
        record.questionId,
        record.choice || record.note,
      ]),
    ).toEqual([
      ["Q1", "SQLite"],
      ["Q2", "typed"],
    ]);
    // An older save result loses to the workspace the panel already shows.
    expect(
      draftedAnswersForComposer("t1", shown, { saved: workspace([], 3) })?.map(
        (record) => record.questionId,
      ),
    ).toEqual(["Q1"]);
  });

  it("queues nothing when a save failed", () => {
    expect(
      draftedAnswersForComposer("t1", workspace([open("Q1", draft(["pg"], 2))]), null),
    ).toBeNull();
  });
});
