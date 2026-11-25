import {
  ComposerContextId,
  MessageId,
  RunId,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type ArtifactAnswerContextRecord,
  type OrchestrationV2Run,
  type ThreadQuestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { questionDeliveries } from "./questionDelivery.ts";

const at = DateTime.makeUnsafe("2026-11-05T12:00:00.000Z");
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
const run = (
  id: string,
  userMessageId: string,
  status: OrchestrationV2Run["status"],
  extra: Partial<OrchestrationV2Run> = {},
) => ({
  id: RunId.make(id),
  userMessageId: MessageId.make(userMessageId),
  status,
  startedAt: status === "queued" || status === "preparing" ? null : at,
  ...extra,
});
const reach = (
  questions: ReadonlyArray<ThreadQuestion>,
  messages: ReadonlyArray<ReturnType<typeof message>>,
  runs: ReadonlyArray<ReturnType<typeof run>>,
) =>
  Object.fromEntries(
    [...questionDeliveries(questions, messages, runs)].map(([id, delivery]) => [
      id,
      `${delivery.messageId}:${delivery.received ? "received" : "sent"}`,
    ]),
  );

describe("questionDeliveries", () => {
  it("is sent while the carrying turn waits and received once it starts", () => {
    const m1 = message("m1", [record("Q1")]);
    expect(reach([question("Q1")], [m1], [run("r1", "m1", "queued")])).toEqual({
      Q1: "m1:sent",
    });
    expect(reach([question("Q1")], [m1], [run("r1", "m1", "preparing")])).toEqual({
      Q1: "m1:sent",
    });
    for (const status of ["starting", "running", "waiting", "completed", "interrupted"] as const)
      expect(reach([question("Q1")], [m1], [run("r1", "m1", status)])).toEqual({
        Q1: "m1:received",
      });
  });

  it("returns an answer to the user when its turn never started", () => {
    const m1 = message("m1", [record("Q1")]);
    for (const status of ["cancelled", "failed", "rolled_back"] as const)
      expect(reach([question("Q1")], [m1], [run("r1", "m1", status, { startedAt: null })])).toEqual(
        {},
      );
    // A message whose run is not recorded carries nothing anywhere.
    expect(reach([question("Q1")], [m1], [])).toEqual({});
    // A run that started and then failed still reached the agent.
    expect(reach([question("Q1")], [m1], [run("r1", "m1", "failed")])).toEqual({
      Q1: "m1:received",
    });
  });

  it("follows a queued message steered into a running turn", () => {
    const m2 = message("m2", [record("Q1")]);
    const placeholder = run("r2", "m2", "cancelled", {
      startedAt: null,
      mergedIntoRunId: RunId.make("r1"),
    });
    expect(reach([question("Q1")], [m2], [placeholder, run("r1", "m1", "queued")])).toEqual({
      Q1: "m2:sent",
    });
    expect(
      reach(
        [question("Q1")],
        [m2],
        [placeholder, run("r1", "m1", "running", { inputMessageIds: [MessageId.make("m2")] })],
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

  it("prefers a message whose turn started over one still queued", () => {
    expect(
      reach(
        [question("Q1")],
        [message("m1", [record("Q1")]), message("m2", [record("Q1")])],
        [run("r1", "m1", "running"), run("r2", "m2", "queued")],
      ),
    ).toEqual({ Q1: "m1:received" });
  });
});
