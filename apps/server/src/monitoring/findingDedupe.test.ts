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
type Filed = { readonly ids: ReadonlyArray<string>; readonly other?: true };
const findings = (filed: ReadonlyArray<Filed>) =>
  filed.map((item) => ({
    threadId: item.other ? ThreadId.make("other") : thread,
    evidence: cite(...item.ids),
  }));

it.each<
  [string, ReturnType<typeof candidate>, ReadonlyArray<Filed>, ReadonlyArray<Filed>, boolean]
>([
  ["new evidence, nothing filed", candidate("a"), [], [], false],
  ["only reviewed context", candidate("seen"), [], [], true],
  ["reviewed context and a new message", candidate("seen", "a"), [], [], false],
  [
    "new message beside an open finding's context message",
    candidate("seen", "a"),
    [{ ids: ["seen"] }],
    [],
    false,
  ],
  ["only messages earlier findings cited", candidate("a"), [{ ids: ["a", "b"] }], [], true],
  ["a cited message and an uncited one", candidate("a", "b"), [{ ids: ["a"] }], [], false],
  [
    "shares a new message with this review's finding",
    candidate("a", "b"),
    [],
    [{ ids: ["b"] }],
    true,
  ],
  ["new message this review has not filed", candidate("a"), [], [{ ids: ["b"] }], false],
  ["earlier finding on another thread", candidate("a"), [{ ids: ["a"], other: true }], [], false],
])("%s", (_name, finding, prior, raised, repeats) => {
  assert.equal(repeatsKnownIncident(finding, snapshot, findings(prior), findings(raised)), repeats);
});
