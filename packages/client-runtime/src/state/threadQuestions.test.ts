import type { ThreadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sectionThreadQuestions,
  syncComposerQuestionAnswers,
  threadQuestionAnswerRecord,
  threadQuestionCounts,
  threadQuestionDiscussRecord,
  threadQuestionsInComposer,
  threadQuestionStatus,
  withComposerQuestionAnswer,
  withoutComposerQuestionAnswer,
} from "./threadQuestions.ts";

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
const draft = (chosenOptionIds: string[], notes = "", draftRevision = 1) => ({
  chosenOptionIds,
  notes,
  submittedAt: null,
  draftRevision,
});
const sentIn = "message-1" as ThreadQuestion["sentInMessageId"];

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
        question("Q6", "open", { answer: draft(["a"]), sentInMessageId: sentIn }),
        question("Q7", "deferred", { answer: draft(["b"]), sentInMessageId: sentIn }),
      ]),
    ).toEqual({ waiting: 3, deferred: 1, drafted: 2 });
  });

  it("names where each answer is", () => {
    const cases: Array<[ThreadQuestion, boolean, string]> = [
      [question("Q1", "open"), false, "open"],
      [question("Q1", "open"), true, "open"],
      [question("Q1", "deferred"), false, "deferred"],
      [question("Q1", "open", { answer: draft([], " ") }), true, "open"],
      [question("Q1", "open", { answer: draft(["a"]) }), false, "drafted"],
      [question("Q1", "deferred", { answer: draft([], "later") }), false, "drafted"],
      [question("Q1", "open", { answer: draft(["a"]) }), true, "in-composer"],
      [question("Q1", "open", { answer: draft(["a"]), sentInMessageId: sentIn }), true, "sent"],
      [
        question("Q1", "answered", { answeredBy: "user", sentInMessageId: sentIn }),
        false,
        "received",
      ],
      [question("Q1", "answered", { answeredBy: "agent" }), false, "recorded"],
      [question("Q1", "withdrawn"), false, "dismissed"],
      [question("Q1", "replaced"), false, "replaced"],
    ];
    for (const [entry, inComposer, status] of cases)
      expect([entry.state, inComposer, threadQuestionStatus(entry, inComposer)]).toEqual([
        entry.state,
        inComposer,
        status,
      ]);
  });

  it("builds a composer answer only from a draft, with one context id per question", () => {
    expect(threadQuestionAnswerRecord("t1", question("Q1", "open"))).toBeNull();
    expect(
      threadQuestionAnswerRecord(
        "t1",
        question("Q1", "open", { answer: draft(["a"]), sentInMessageId: sentIn }),
      ),
    ).toBeNull();
    const first = threadQuestionAnswerRecord(
      "t1",
      question("Q1", "open", { answer: draft(["a"]) }),
    );
    const edited = threadQuestionAnswerRecord(
      "t1",
      question("Q1", "open", { answer: draft(["b"], "why", 4) }),
    );
    expect(first).toMatchObject({
      kind: "artifact-answer",
      artifactId: "thread-questions",
      questionId: "Q1",
      answerRevision: 1,
      label: "Q1: Prompt Q1",
      question: "Prompt Q1",
      choice: "Alpha",
      note: "",
    });
    expect(edited).toMatchObject({ answerRevision: 4, choice: "Beta", note: "why" });
    expect(edited?.contextId).toBe(first?.contextId);
    expect(
      threadQuestionAnswerRecord("t2", question("Q1", "open", { answer: draft(["a"]) }))?.contextId,
    ).not.toBe(first?.contextId);
  });

  it("keeps composer answers in step with their questions", () => {
    const drafted = question("Q1", "open", { answer: draft(["a"]) });
    const record = threadQuestionAnswerRecord("t1", drafted)!;
    const other = { ...record, artifactId: "artifact-1", contextId: record.contextId };
    expect(syncComposerQuestionAnswers("t1", [record, other], [drafted])).toBeNull();
    // The draft moved on: the chip follows it in place.
    const moved = question("Q1", "open", { answer: draft(["b"], "", 3) });
    expect(syncComposerQuestionAnswers("t1", [record], [moved])).toEqual([
      threadQuestionAnswerRecord("t1", moved),
    ]);
    // Closed, sent, cleared or gone: the chip leaves; an artifact answer stays.
    for (const gone of [
      [question("Q1", "withdrawn", { answer: draft(["a"]) })],
      [question("Q1", "replaced", { answer: draft(["a"]) })],
      [question("Q1", "answered", { answer: draft(["a"]), answeredBy: "agent" })],
      [question("Q1", "open", { answer: draft(["a"]), sentInMessageId: sentIn })],
      [question("Q1", "open", { answer: draft([], "") })],
      [],
    ])
      expect(syncComposerQuestionAnswers("t1", [record, other], gone)).toEqual([other]);
  });

  it("adds, replaces and removes one question's composer answer", () => {
    const first = threadQuestionAnswerRecord(
      "t1",
      question("Q1", "open", { answer: draft(["a"]) }),
    )!;
    const second = threadQuestionAnswerRecord(
      "t1",
      question("Q2", "open", { answer: draft(["b"]) }),
    )!;
    const replaced = { ...first, choice: "Beta", answerRevision: 2 };
    expect(withComposerQuestionAnswer([first], second)).toEqual([first, second]);
    expect(withComposerQuestionAnswer([first, second], replaced)).toEqual([replaced, second]);
    expect(withoutComposerQuestionAnswer([first, second], "Q1")).toEqual([second]);
    expect(withoutComposerQuestionAnswer([first], "Q9")).toEqual([first]);
    const artifact = { ...first, artifactId: "artifact-1", questionId: "Q7" };
    expect([...threadQuestionsInComposer([first, second, artifact])]).toEqual([
      ["Q1", "answer"],
      ["Q2", "answer"],
    ]);
  });

  it("holds an answer or a discussion for a question in the composer, never both", () => {
    const drafted = question("Q1", "open", { answer: draft(["a"], "why not b?") });
    const answer = threadQuestionAnswerRecord("t1", drafted)!;
    const discuss = threadQuestionDiscussRecord("t1", drafted)!;
    // The discussion carries the note alone, so the chosen option stays a draft.
    expect(discuss).toMatchObject({
      artifactId: "thread-question-comments",
      questionId: "Q1",
      label: "Q1 · discuss: Prompt Q1",
      choice: "",
      note: "why not b?",
    });
    expect(discuss.contextId).not.toBe(answer.contextId);
    const withDiscuss = withComposerQuestionAnswer([answer], discuss);
    expect(withDiscuss).toEqual([discuss]);
    expect([...threadQuestionsInComposer(withDiscuss)]).toEqual([["Q1", "discuss"]]);
    expect(withComposerQuestionAnswer(withDiscuss, answer)).toEqual([answer]);
    expect(withoutComposerQuestionAnswer(withDiscuss, "Q1")).toEqual([]);
  });

  it("discusses only a waiting question with a note, and follows that note", () => {
    expect(
      threadQuestionDiscussRecord("t1", question("Q1", "open", { answer: draft(["a"]) })),
    ).toBeNull();
    expect(threadQuestionDiscussRecord("t1", question("Q1", "open"))).toBeNull();
    expect(
      threadQuestionDiscussRecord("t1", question("Q1", "answered", { answer: draft([], "hm") })),
    ).toBeNull();
    expect(
      threadQuestionDiscussRecord(
        "t1",
        question("Q1", "open", { answer: draft([], "hm"), sentInMessageId: sentIn }),
      ),
    ).toBeNull();
    const before = question("Q1", "deferred", { answer: draft([], "first") });
    const record = threadQuestionDiscussRecord("t1", before)!;
    const after = question("Q1", "deferred", { answer: draft([], "second", 4) });
    expect(syncComposerQuestionAnswers("t1", [record], [after])).toEqual([
      threadQuestionDiscussRecord("t1", after),
    ]);
    expect(
      syncComposerQuestionAnswers(
        "t1",
        [record],
        [question("Q1", "deferred", { answer: draft([], " ") })],
      ),
    ).toEqual([]);
    // Its status stays the question's own: a discussion is not an answer in the composer.
    expect(threadQuestionStatus(after, false)).toBe("drafted");
  });
});
