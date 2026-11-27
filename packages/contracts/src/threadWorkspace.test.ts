import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadQuestion, ThreadWorkspace } from "./threadWorkspace.ts";

const decodeQuestion = Schema.decodeUnknownSync(ThreadQuestion);
const decodeWorkspace = Schema.decodeUnknownSync(ThreadWorkspace);

const question = {
  id: "Q1",
  prompt: "Which team owns the staging alerts channel?",
  options: [],
  recommendedOptionIds: [],
  multiSelect: false,
  state: "answered",
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: "2026-01-02T00:00:00.000Z",
  answer: { chosenOptionIds: [], notes: "Platform", submittedAt: "2026-01-02T00:00:00.000Z" },
  answeredBy: "agent",
  replacedBy: null,
};

describe("ThreadQuestion", () => {
  it("decodes a question written before it could name the message it was answered from", () => {
    const decoded = decodeQuestion(question);
    expect(decoded.settledFromMessageId).toBeUndefined();
    expect(
      decodeWorkspace({
        threadId: "thread-1",
        revision: 1,
        items: [],
        artifacts: [],
        questions: [question],
        summaryNotes: "",
        childPreamble: "",
        updatedAt: null,
      }).questions[0]?.state,
    ).toBe("answered");
  });

  it("keeps the message an agent recorded the answer from", () => {
    expect(
      decodeQuestion({ ...question, settledFromMessageId: "message-7" }).settledFromMessageId,
    ).toBe("message-7");
  });
});
