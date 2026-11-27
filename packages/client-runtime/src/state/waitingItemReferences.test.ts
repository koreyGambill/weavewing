import {
  ComposerContextId,
  MessageId,
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type ComposerContextRecord,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  itemReferences,
  nextReferencePosition,
  questionPointers,
  waitingItemReferenceIndex,
} from "./waitingItemReferences.ts";

const answer = (questionId: string, artifactId = THREAD_QUESTIONS_ARTIFACT_ID) =>
  ({
    version: 1,
    kind: "artifact-answer",
    contextId: ComposerContextId.make(`answer_${artifactId}_${questionId}`),
    label: questionId,
    artifactId,
    questionId,
    answerRevision: 1,
    title: questionId,
    artifactVersion: 1,
    question: `${questionId}?`,
    choice: "Yes",
    note: "",
  }) satisfies ComposerContextRecord;
const discuss = (itemKind: "question" | "qa" | "task", key: string) =>
  ({
    version: 1,
    kind: "waiting-item",
    contextId: ComposerContextId.make(`waiting-item_${itemKind}-${key.replace("/", "-")}`),
    label: `${key} · discuss`,
    itemKind,
    key,
    ref: key,
    title: key,
  }) satisfies ComposerContextRecord;
const message = (
  id: string,
  records: ReadonlyArray<ComposerContextRecord>,
  options: { role?: string; cite?: boolean } = {},
) => ({
  id: MessageId.make(id),
  role: options.role ?? "user",
  text: [
    "About these:",
    ...(options.cite === false
      ? []
      : records.map((record) => formatComposerContextReference(record))),
  ].join(" "),
  context: { records: [...records] },
});
const ids = (references: ReadonlyArray<{ readonly messageId: string }> | undefined) =>
  (references ?? []).map((reference) => reference.messageId);

describe("waitingItemReferenceIndex", () => {
  it("collects answers, comments and Discuss references per item, oldest first", () => {
    const index = waitingItemReferenceIndex([
      message("m1", [answer("Q1", THREAD_QUESTION_COMMENTS_ARTIFACT_ID)]),
      message("m2", [discuss("question", "Q1"), discuss("qa", "landing/toast")]),
      message("m3", [answer("Q1"), discuss("task", "task-1")]),
    ]);
    expect(index.get("question:Q1")).toEqual([
      { messageId: "m1", target: "block" },
      { messageId: "m2", target: "message" },
      { messageId: "m3", target: "block" },
    ]);
    expect(ids(index.get("qa:landing/toast"))).toEqual(["m2"]);
    expect(ids(index.get("task:task-1"))).toEqual(["m3"]);
  });

  it("counts only user messages, only cited records, and each message once per item", () => {
    const index = waitingItemReferenceIndex([
      message("agent", [answer("Q1")], { role: "assistant" }),
      message("uncited", [answer("Q1")], { cite: false }),
      message("twice", [answer("Q1"), discuss("question", "Q1")]),
    ]);
    expect(index.get("question:Q1")).toEqual([{ messageId: "twice", target: "block" }]);
  });
});

describe("itemReferences", () => {
  const index = waitingItemReferenceIndex([message("m2", [discuss("task", "task-1")])]);
  const messageOrder = new Map([
    ["m1", 0],
    ["m2", 1],
    ["m3", 2],
  ]);

  it("adds the loaded messages an item names itself, in timeline order", () => {
    expect(
      ids(
        itemReferences({
          index,
          item: { kind: "task", taskId: "task-1" },
          messageOrder,
          pointers: [MessageId.make("m3"), MessageId.make("m1"), MessageId.make("m2")],
        }),
      ),
    ).toEqual(["m1", "m2", "m3"]);
  });

  it("finds a question answered in prose at the message the agent recorded it from", () => {
    expect(
      ids(
        itemReferences({
          index,
          item: { kind: "question", questionId: "Q2" },
          messageOrder,
          pointers: questionPointers({ settledFromMessageId: MessageId.make("m3") }),
        }),
      ),
    ).toEqual(["m3"]);
  });

  it("leaves out pointers to messages that are not loaded", () => {
    expect(
      ids(
        itemReferences({
          index,
          item: { kind: "qa", landingId: "landing", changeId: "toast" },
          messageOrder,
          pointers: [MessageId.make("older"), undefined],
        }),
      ),
    ).toEqual([]);
  });
});

describe("nextReferencePosition", () => {
  it("starts with the oldest, steps forward and wraps after the last", () => {
    expect(nextReferencePosition(null, 3)).toBe(0);
    expect(nextReferencePosition(0, 3)).toBe(1);
    expect(nextReferencePosition(1, 3)).toBe(2);
    expect(nextReferencePosition(2, 3)).toBe(0);
  });

  it("starts over when the list shrank past the one shown", () => {
    expect(nextReferencePosition(4, 2)).toBe(0);
  });
});
