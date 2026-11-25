import { THREAD_QUESTIONS_REFRESH_REQUEST, type ThreadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isThreadQuestionRecord,
  nextThreadQuestionImageNumber,
  sectionThreadQuestions,
  syncComposerQuestionAnswers,
  threadQuestionChipText,
  threadQuestionAnswerRecord,
  threadQuestionCounts,
  threadQuestionDiscussRecord,
  threadQuestionImageMarker,
  threadQuestionImageMarkerNumbers,
  threadQuestionImageName,
  threadQuestionImageNumber,
  threadQuestionImagesWithoutMarkers,
  threadQuestionMarkersDroppedByChip,
  threadQuestionsInComposer,
  withoutThreadQuestionImageMarkers,
  threadQuestionReplaced,
  threadQuestionStatus,
  withQuestionsRefreshRequest,
  withComposerQuestionAnswer,
  withoutComposerQuestionAnswer,
  withoutThreadQuestionRecords,
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

  it("names where each answer or comment is", () => {
    const discussedIn = "message-2" as ThreadQuestion["discussedInMessageId"];
    const cases: Array<[ThreadQuestion, "answer" | "discuss" | undefined, string]> = [
      [question("Q1", "open"), undefined, "open"],
      [question("Q1", "open"), "answer", "open"],
      [question("Q1", "deferred"), undefined, "deferred"],
      [question("Q1", "open", { answer: draft([], " ") }), "answer", "open"],
      [question("Q1", "open", { answer: draft(["a"]) }), undefined, "drafted"],
      [question("Q1", "deferred", { answer: draft([], "later") }), undefined, "drafted"],
      [question("Q1", "open", { answer: draft(["a"]) }), "answer", "in-composer"],
      [question("Q1", "open", { answer: draft(["a"], "why") }), "discuss", "comment-in-composer"],
      [question("Q1", "open", { answer: draft(["a"]), sentInMessageId: sentIn }), "answer", "sent"],
      // A sent comment outranks the choice it left behind as a draft.
      [
        question("Q1", "open", { answer: draft(["a"]), discussedInMessageId: discussedIn }),
        undefined,
        "discussing",
      ],
      [
        question("Q1", "open", { answer: draft([], "why"), discussedInMessageId: discussedIn }),
        undefined,
        "discussing",
      ],
      // An answer the agent reopened to reply to keeps its choice and note as a draft.
      [
        question("Q1", "open", { answer: draft(["a"], "why"), discussedInMessageId: discussedIn }),
        undefined,
        "discussing",
      ],
      [
        question("Q1", "open", { answer: draft(["a"]), discussedInMessageId: discussedIn }),
        "answer",
        "in-composer",
      ],
      [
        question("Q1", "open", { answer: draft([], "more"), discussedInMessageId: discussedIn }),
        "discuss",
        "comment-in-composer",
      ],
      [
        question("Q1", "open", {
          answer: draft(["a"]),
          discussedInMessageId: discussedIn,
          sentInMessageId: sentIn,
        }),
        undefined,
        "sent",
      ],
      [
        question("Q1", "answered", { answeredBy: "user", sentInMessageId: sentIn }),
        undefined,
        "received",
      ],
      [question("Q1", "answered", { answeredBy: "agent" }), undefined, "recorded"],
      [question("Q1", "withdrawn"), undefined, "dismissed"],
      [question("Q1", "replaced", { discussedInMessageId: discussedIn }), undefined, "replaced"],
    ];
    for (const [entry, inComposer, status] of cases)
      expect([entry.state, inComposer, threadQuestionStatus(entry, inComposer)]).toEqual([
        entry.state,
        inComposer,
        status,
      ]);
  });

  it("adds the refresh request after what the composer holds, once", () => {
    expect(withQuestionsRefreshRequest("")).toBe(THREAD_QUESTIONS_REFRESH_REQUEST);
    const added = withQuestionsRefreshRequest("Also rename the flag.\n");
    expect(added).toBe(`Also rename the flag.\n\n${THREAD_QUESTIONS_REFRESH_REQUEST}`);
    expect(withQuestionsRefreshRequest(added)).toBe(added);
  });

  it("finds the question a replacement replaced", () => {
    const questions = [
      question("Q1", "replaced", { replacedBy: "Q2" }),
      question("Q2", "replaced", { replacedBy: "Q3" }),
      question("Q3", "open"),
    ];
    expect(["Q1", "Q2", "Q3"].map((id) => threadQuestionReplaced(questions, id))).toEqual([
      null,
      "Q1",
      "Q2",
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
    const snapshot = (revision: number, ...questions: ThreadQuestion[]) => ({
      revision,
      questions,
    });
    expect(syncComposerQuestionAnswers("t1", [record, other], snapshot(1, drafted))).toBeNull();
    // A newer draft: the chip follows it in place.
    const moved = question("Q1", "open", { answer: draft(["b"], "", 3) });
    expect(syncComposerQuestionAnswers("t1", [record], snapshot(3, moved))).toEqual([
      threadQuestionAnswerRecord("t1", moved),
    ]);
    // Closed or sent in any snapshot: the chip leaves; an artifact answer stays.
    for (const gone of [
      question("Q1", "withdrawn", { answer: draft(["a"]) }),
      question("Q1", "replaced", { answer: draft(["a"]) }),
      question("Q1", "answered", { answer: draft(["a"]), answeredBy: "agent" }),
      question("Q1", "open", { answer: draft(["a"]), sentInMessageId: sentIn }),
    ])
      expect(syncComposerQuestionAnswers("t1", [record, other], snapshot(1, gone))).toEqual([
        other,
      ]);
    // A draft cleared in a snapshot at least as new as the chip removes it.
    const cleared = question("Q1", "open", { answer: draft([], "", 2) });
    expect(syncComposerQuestionAnswers("t1", [record, other], snapshot(2, cleared))).toEqual([
      other,
    ]);
  });

  it("lets no older snapshot from another tile change a chip", () => {
    const newer = threadQuestionAnswerRecord(
      "t1",
      question("Q1", "open", { answer: draft(["b"], "", 5) }),
    )!;
    const older = question("Q1", "open", { answer: draft(["a"], "", 3) });
    expect(
      syncComposerQuestionAnswers("t1", [newer], { revision: 3, questions: [older] }),
    ).toBeNull();
    const notYetDrafted = question("Q1", "open");
    expect(
      syncComposerQuestionAnswers("t1", [newer], { revision: 4, questions: [notYetDrafted] }),
    ).toBeNull();
    // A snapshot from before the question existed.
    expect(syncComposerQuestionAnswers("t1", [newer], { revision: 1, questions: [] })).toBeNull();
    // Draft A was sent and cancelled, then draft B chipped; a stale snapshot still shows A sent.
    const staleSent = question("Q1", "open", {
      answer: draft(["a"], "", 3),
      sentInMessageId: sentIn,
    });
    expect(
      syncComposerQuestionAnswers("t1", [newer], { revision: 3, questions: [staleSent] }),
    ).toBeNull();
    // From before the question was reopened and redrafted, when it was still answered.
    const staleAnswered = question("Q1", "answered", {
      answer: draft(["a"], "", 3),
      answeredBy: "user",
    });
    expect(
      syncComposerQuestionAnswers("t1", [newer], { revision: 4, questions: [staleAnswered] }),
    ).toBeNull();
  });

  it("takes every question chip out of the composer and leaves other answers", () => {
    const answer = threadQuestionAnswerRecord(
      "t1",
      question("Q1", "open", { answer: draft(["a"], "hm") }),
    )!;
    const discuss = threadQuestionDiscussRecord(
      "t1",
      question("Q2", "open", { answer: draft([], "why?") }),
    )!;
    const artifact = { ...answer, artifactId: "artifact-1", questionId: "q-1" };
    expect(withoutThreadQuestionRecords([answer, artifact, discuss])).toEqual([artifact]);
    expect(withoutThreadQuestionRecords([artifact])).toBeNull();
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
    expect(
      syncComposerQuestionAnswers("t1", [record], { revision: 4, questions: [after] }),
    ).toEqual([threadQuestionDiscussRecord("t1", after)]);
    expect(
      syncComposerQuestionAnswers("t1", [record], {
        revision: 4,
        questions: [question("Q1", "deferred", { answer: draft([], " ", 4) })],
      }),
    ).toEqual([]);
    expect(threadQuestionStatus(after, undefined)).toBe("drafted");
    expect(threadQuestionStatus(after, "discuss")).toBe("comment-in-composer");
  });

  it("shows the answer or the start of the note on a question's chip", () => {
    const drafted = question("Q5", "open", {
      prompt: "Request timeout for src/client.ts?",
      answer: draft(["b"], "keep it\n short"),
    });
    const answer = threadQuestionAnswerRecord("t1", drafted)!;
    expect(threadQuestionChipText(answer)).toBe("Q5 · Request timeout for src/client.ts? · Beta");
    expect(threadQuestionChipText({ ...answer, choice: "" })).toBe(
      "Q5 · Request timeout for src/client.ts? · keep it short",
    );
    const discuss = threadQuestionDiscussRecord("t1", {
      ...drafted,
      answer: draft([], "x".repeat(70)),
    })!;
    expect(threadQuestionChipText(discuss)).toBe(`Q5 · discuss · ${"x".repeat(60)}…`);
    expect(threadQuestionChipText({ ...answer, artifactId: "artifact-1" })).toBeNull();
  });

  it("pairs a question's pasted images with the markers in its note", () => {
    expect(threadQuestionImageMarker("Q1", 2)).toBe("[Q1 image 2]");
    expect(threadQuestionImageName("Q1", 2, "png")).toBe("Q1-image-2.png");
    expect(threadQuestionImageNumber("Q1", "Q1-image-2.png")).toBe(2);
    // Another question's image, or a name that only starts the same way, is not this one's.
    expect(threadQuestionImageNumber("Q1", "Q12-image-2.png")).toBeNull();
    expect(threadQuestionImageNumber("Q1", "image.png")).toBeNull();
    expect([
      ...threadQuestionImageMarkerNumbers("Q1", "see [Q1 image 1] and [Q1 image 3], [Q12 image 2]"),
    ]).toEqual([1, 3]);
  });

  it("deletes a marker in whatever spelling counts as that image", () => {
    const note = "like [Q1 image 01] and [Q1 image 2], not [Q12 image 1]";
    expect([...threadQuestionImageMarkerNumbers("Q1", note)]).toEqual([1, 2]);
    expect(withoutThreadQuestionImageMarkers("Q1", note, new Set([1]))).toBe(
      "like and [Q1 image 2], not [Q12 image 1]",
    );
    expect(withoutThreadQuestionImageMarkers("Q1", "[Q1 image 1] [Q1 image 2]", new Set([1]))).toBe(
      "[Q1 image 2]",
    );
    expect(
      withoutThreadQuestionImageMarkers("Q1", "[Q1 image 1] [Q1 image 2]", new Set([1, 2])),
    ).toBe("");
  });

  it("drops from the note only markers the chip lost whose image is gone", () => {
    const note = "[Q1 image 1] [Q1 image 2] [Q1 image 3]";
    // Image 1 left the message; image 2 was pasted after staging and is still held.
    expect([
      ...threadQuestionMarkersDroppedByChip("Q1", note, "[Q1 image 3]", [
        "Q1-image-2.png",
        "Q1-image-3.png",
      ]),
    ]).toEqual([1]);
    // On a device that holds none of the images, a chip carrying every marker drops nothing.
    expect([...threadQuestionMarkersDroppedByChip("Q1", note, note, [])]).toEqual([]);
  });

  it("numbers a new image past every held image and every marker still in the note", () => {
    expect(nextThreadQuestionImageNumber("Q1", [], "")).toBe(1);
    expect(nextThreadQuestionImageNumber("Q1", ["Q1-image-1.png", "Q2-image-7.png"], "")).toBe(2);
    expect(nextThreadQuestionImageNumber("Q1", ["Q1-image-1.png"], "[Q1 image 4]")).toBe(5);
  });

  it("finds the held images whose markers were deleted from the note", () => {
    const images = [
      { id: "one", name: "Q1-image-1.png" },
      { id: "two", name: "Q1-image-2.png" },
    ];
    expect(threadQuestionImagesWithoutMarkers("Q1", images, "[Q1 image 2] only")).toEqual(["one"]);
    expect(threadQuestionImagesWithoutMarkers("Q1", images, "[Q1 image 1][Q1 image 2]")).toEqual(
      [],
    );
  });

  it("tells question answers and comments from other artifacts' answers", () => {
    const answer = threadQuestionAnswerRecord(
      "t1",
      question("Q1", "open", { answer: draft(["a"], "") }),
    )!;
    expect(isThreadQuestionRecord(answer)).toBe(true);
    expect(isThreadQuestionRecord({ ...answer, artifactId: "rollout" })).toBe(false);
  });
});
