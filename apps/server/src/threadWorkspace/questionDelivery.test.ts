import {
  ComposerContextId,
  MessageId,
  RunAttemptId,
  RunId,
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type ArtifactAnswerContextRecord,
  type OrchestrationV2Run,
  type ThreadQuestion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { questionDeliveries, runsWithProviderTurn } from "./questionDelivery.ts";

const question = (id: string, extra: Partial<ThreadQuestion> = {}): ThreadQuestion => ({
  id,
  prompt: id,
  options: [],
  recommendedOptionIds: [],
  multiSelect: false,
  state: "open",
  createdAt: "2026-11-05T12:00:00.000Z",
  closedAt: null,
  answer: { chosenOptionIds: [], notes: "yes", submittedAt: null, draftRevision: 3 },
  answeredBy: null,
  replacedBy: null,
  ...extra,
});
const record = (
  questionId: string,
  answerRevision = 3,
  artifactId = THREAD_QUESTIONS_ARTIFACT_ID,
): ArtifactAnswerContextRecord => ({
  version: 1,
  kind: "artifact-answer",
  contextId: ComposerContextId.make(`answer_${questionId}`),
  label: questionId,
  artifactId,
  questionId,
  answerRevision,
  title: questionId,
  artifactVersion: 1,
  question: questionId,
  choice: "",
  note: "yes",
});
const message = (
  id: string,
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
  createdBy: "user" | "agent" = "user",
) => ({
  id: MessageId.make(id),
  role: "user" as const,
  createdBy,
  context: { version: 1 as const, records: [...records] },
});
// `accepted`: a provider turn exists for one of the run's attempts.
const run = (
  id: string,
  userMessageId: string,
  status: OrchestrationV2Run["status"],
  extra: Partial<OrchestrationV2Run> & { readonly accepted?: boolean } = {},
) => ({
  id: RunId.make(id),
  userMessageId: MessageId.make(userMessageId),
  status,
  accepted: false,
  ...extra,
});
const reach = (
  questions: ReadonlyArray<ThreadQuestion>,
  messages: ReadonlyArray<ReturnType<typeof message>>,
  runs: ReadonlyArray<ReturnType<typeof run>>,
) =>
  Object.fromEntries(
    [
      ...questionDeliveries(
        questions,
        messages,
        runs,
        new Set(runs.filter((entry) => entry.accepted).map((entry) => entry.id)),
      ),
    ].map(([id, delivery]) => [
      id,
      `${delivery.messageId}:${delivery.received ? "received" : "sent"}`,
    ]),
  );

describe("runsWithProviderTurn", () => {
  it("finds the runs one of whose attempts has a provider turn", () => {
    const attempt = (id: string, runId: string) => ({
      id: RunAttemptId.make(id),
      runId: RunId.make(runId),
    });
    expect([
      ...runsWithProviderTurn(
        [attempt("a1", "r1"), attempt("a2", "r2"), attempt("a3", "r2")],
        [{ runAttemptId: RunAttemptId.make("a3") }, { runAttemptId: null }],
      ),
    ]).toEqual(["r2"]);
  });
});

describe("questionDeliveries", () => {
  it("is sent until a provider accepts the carrying turn, whatever the run says", () => {
    const m1 = message("m1", [record("Q1")]);
    // The start service marks a run running, with a start time, before it calls the adapter.
    for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const)
      expect(reach([question("Q1")], [m1], [run("r1", "m1", status)])).toEqual({
        Q1: "m1:sent",
      });
    for (const status of ["starting", "running", "completed", "interrupted", "failed"] as const)
      expect(reach([question("Q1")], [m1], [run("r1", "m1", status, { accepted: true })])).toEqual({
        Q1: "m1:received",
      });
  });

  it("returns an answer to the user when its run ended before a provider accepted it", () => {
    const m1 = message("m1", [record("Q1")]);
    for (const status of [
      "cancelled",
      "failed",
      "rolled_back",
      "completed",
      "interrupted",
    ] as const)
      expect(reach([question("Q1")], [m1], [run("r1", "m1", status)])).toEqual({});
    // A message whose run is not recorded carries nothing anywhere.
    expect(reach([question("Q1")], [m1], [])).toEqual({});
  });

  it("follows a queued message steered into a running turn", () => {
    const m2 = message("m2", [record("Q1")]);
    const placeholder = run("r2", "m2", "cancelled", { mergedIntoRunId: RunId.make("r1") });
    expect(reach([question("Q1")], [m2], [placeholder, run("r1", "m1", "queued")])).toEqual({
      Q1: "m2:sent",
    });
    expect(
      reach(
        [question("Q1")],
        [m2],
        [
          placeholder,
          run("r1", "m1", "running", { inputMessageIds: [MessageId.make("m2")], accepted: true }),
        ],
      ),
    ).toEqual({ Q1: "m2:received" });
  });

  it("matches only the current draft of a waiting question from the user", () => {
    const runs = [run("r1", "m1", "queued")];
    expect(reach([question("Q1")], [message("m1", [record("Q1", 2)])], runs)).toEqual({});
    expect(reach([question("Q1")], [message("m1", [record("Q1", 3, "artifact-1")])], runs)).toEqual(
      {},
    );
    expect(reach([question("Q1")], [message("m1", [record("Q1")], "agent")], runs)).toEqual({});
    expect(
      reach([question("Q1", { state: "withdrawn" })], [message("m1", [record("Q1")])], runs),
    ).toEqual({});
    expect(
      reach([question("Q1", { answer: null })], [message("m1", [record("Q1", 0)])], runs),
    ).toEqual({});
  });

  it("prefers a message whose turn was accepted over one still queued", () => {
    expect(
      reach(
        [question("Q1")],
        [message("m1", [record("Q1")]), message("m2", [record("Q1")])],
        [run("r1", "m1", "running", { accepted: true }), run("r2", "m2", "queued")],
      ),
    ).toEqual({ Q1: "m1:received" });
  });

  it("ignores a comment that discusses a question, queued or accepted", () => {
    const comment = message("m1", [record("Q1", 3, THREAD_QUESTION_COMMENTS_ARTIFACT_ID)]);
    expect(reach([question("Q1")], [comment], [run("r1", "m1", "queued")])).toEqual({});
    expect(
      reach([question("Q1")], [comment], [run("r1", "m1", "running", { accepted: true })]),
    ).toEqual({});
  });

  it("does not count a record whose answer differs from the draft under the same revision", () => {
    const edited = { ...record("Q1"), note: "no, actually" };
    expect(reach([question("Q1")], [message("m1", [edited])], [run("r1", "m1", "queued")])).toEqual(
      {},
    );
    expect(
      reach(
        [question("Q1")],
        [message("m1", [{ ...record("Q1"), choice: "Other" }])],
        [run("r1", "m1", "queued")],
      ),
    ).toEqual({});
  });
});
