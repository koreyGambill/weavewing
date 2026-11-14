import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import { cases, thread } from "./cases.ts";
import { grade, survivors } from "./grade.ts";

const citing = (...messageIds: ReadonlyArray<string>) => [
  {
    threadId: thread,
    ruleId: "user-scope",
    summary: "Landed without review",
    detail: "d",
    confidence: 0.8,
    evidence: messageIds.map((id) => ({
      threadId: thread,
      messageId: MessageId.make(id),
      excerpt: "x",
    })),
  },
];
const repeat = cases.find((entry) => entry.kind === "repeat")!;
const recurrence = cases.find((entry) => entry.kind === "new")!;

describe("grade what the runner would file", () => {
  it.each([
    ["repeat, nothing filed", repeat, [], true],
    ["repeat, refiled on the filed message", repeat, citing("m2"), true],
    ["repeat, filed on a new message", repeat, citing("m4"), false],
    ["new, cites the new message", recurrence, citing("m4"), true],
    ["new, also cites the filed message", recurrence, citing("m2", "m4"), true],
    ["new, cites only the filed message", recurrence, citing("m2"), false],
  ] as const)("%s", (_name, entry, findings, pass) => {
    expect(grade(entry, survivors(entry, findings)).pass).toBe(pass);
  });
});
