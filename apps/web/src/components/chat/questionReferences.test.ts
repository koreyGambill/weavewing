import {
  ComposerContextId,
  MessageId,
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type ArtifactAnswerContextRecord,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { threadQuestionReferences } from "./questionReferences";

function record(
  contextId: string,
  questionId: string,
  artifactId: string = THREAD_QUESTIONS_ARTIFACT_ID,
): ArtifactAnswerContextRecord {
  return {
    version: 1,
    kind: "artifact-answer",
    contextId: ComposerContextId.make(contextId),
    label: questionId,
    artifactId,
    questionId,
    answerRevision: 0,
    title: questionId,
    artifactVersion: 1,
    question: "Which option?",
    choice: artifactId === THREAD_QUESTIONS_ARTIFACT_ID ? "Option A" : "",
    note: "A note",
  };
}

function message(
  id: string,
  records: ArtifactAnswerContextRecord[],
  options: { role?: string; referenced?: ArtifactAnswerContextRecord[] } = {},
) {
  return {
    id: MessageId.make(id),
    role: options.role ?? "user",
    text: (options.referenced ?? records).map(formatComposerContextReference).join(" "),
    context: { version: 1 as const, records },
  };
}

describe("threadQuestionReferences", () => {
  it("lists a question's answers and comments in message order", () => {
    const comment = record("comment_q1", "Q1", THREAD_QUESTION_COMMENTS_ARTIFACT_ID);
    const answer = record("answer_q1", "Q1");
    const otherArtifact = record("other_q1", "Q1", "artifact-plan");
    const unreferenced = record("answer_q1_late", "Q1");
    expect(
      threadQuestionReferences(
        [
          message("m1", [comment, record("answer_q2", "Q2")]),
          message("m2", [otherArtifact]),
          message("m3", [answer], { role: "assistant" }),
          message("m4", [unreferenced], { referenced: [] }),
          message("m5", [answer]),
        ],
        "Q1",
      ),
    ).toEqual([
      { messageId: "m1", mode: "discuss" },
      { messageId: "m5", mode: "answer" },
    ]);
  });
});
