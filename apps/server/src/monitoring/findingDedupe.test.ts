import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { repeatsKnownIncident } from "./findingDedupe.ts";
import type { MonitoringSnapshotData } from "./MonitoringSnapshot.ts";

const thread = ThreadId.make("thread");
const cite = (...ids: ReadonlyArray<string>) =>
  ids.map((id) => ({ threadId: thread, messageId: MessageId.make(id), excerpt: "quote" }));
const snapshot: MonitoringSnapshotData = {
  threads: [
    {
      id: thread,
      title: "Main",
      parentThreadId: null,
      messages: [
        { id: "seen", role: "assistant", text: "quote", priorContext: true },
        { id: "a", role: "assistant", text: "quote" },
        { id: "b", role: "assistant", text: "quote" },
      ],
    },
  ],
  truncated: false,
  coverage: "Chat",
};
const candidate = (...ids: ReadonlyArray<string>) => ({
  threadId: thread,
  ruleId: "rule",
  summary: "s",
  detail: "d",
  confidence: 0.5,
  evidence: cite(...ids),
});

it.each([
  ["new evidence, nothing filed", candidate("a"), [], false],
  ["only reviewed context", candidate("seen"), [], true],
  ["new and reviewed context", candidate("seen", "a"), [], false],
  [
    "shares a message with an open finding",
    candidate("a", "b"),
    [{ ids: ["a"], outcome: null }],
    true,
  ],
  ["shares with an unresolved one", candidate("a"), [{ ids: ["a"], outcome: "unresolved" }], true],
  [
    "recurs after a correction, same messages",
    candidate("a"),
    [{ ids: ["a", "b"], outcome: "corrected" }],
    true,
  ],
  [
    "recurs after a correction, new message",
    candidate("a", "b"),
    [{ ids: ["a"], outcome: "corrected" }],
    false,
  ],
  [
    "after an accepted explanation, same messages",
    candidate("a"),
    [{ ids: ["a"], outcome: "accepted_explanation" }],
    true,
  ],
  [
    "open finding on another thread",
    candidate("a"),
    [{ ids: ["a"], outcome: null, other: true }],
    false,
  ],
] as const)("%s", (_name, finding, prior, repeats) => {
  assert.equal(
    repeatsKnownIncident(
      finding,
      snapshot,
      prior.map((item) => ({
        threadId: "other" in item ? ThreadId.make("other") : thread,
        evidence: cite(...item.ids),
        outcome: item.outcome,
      })),
    ),
    repeats,
  );
});
