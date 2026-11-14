import { describe, expect, it } from "vite-plus/test";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

const thread = ThreadId.make("thread:lead");
const citing = (messageId: string) => ({
  findings: [
    {
      threadId: thread,
      ruleId: "review-before-landing",
      summary: "Landed without review",
      detail: "d",
      confidence: 0.8,
      evidence: [{ threadId: thread, messageId: MessageId.make(messageId), excerpt: "x" }],
    },
  ],
});
const repeat = cases.find((entry) => entry.kind === "repeat")!;
const recurrence = cases.find((entry) => entry.kind === "new")!;

describe("grade", () => {
  it.each([
    ["repeat, nothing filed", repeat, { findings: [] }, true],
    ["repeat, refiled", repeat, citing("m2"), false],
    ["new, cites the new message", recurrence, citing("m4"), true],
    ["new, cites only reviewed context", recurrence, citing("m2"), false],
  ] as const)("%s", (_name, entry, output, pass) => {
    expect(grade(entry, output).pass).toBe(pass);
  });
});
