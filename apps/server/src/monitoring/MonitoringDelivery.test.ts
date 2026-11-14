import { assert, it } from "@effect/vitest";
import {
  MessageId,
  MonitoringFindingId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { monitoringAdvisory, monitoringFollowup } from "./MonitoringDelivery.ts";
import { clip } from "./reviewNotification.ts";

const profile = {
  title: "Standards watcher",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "haiku" },
  rules: [{ id: "rule", title: "Verify changes", instructions: "RULE-INSTRUCTIONS ".repeat(200) }],
};
const thread = ThreadId.make("thread");

it("sends the thread a short advisory and leaves rule instructions and detail to the inbox", () => {
  const text = monitoringAdvisory(profile, {
    id: MonitoringFindingId.make("finding"),
    taskId: ScheduledTaskId.make("task"),
    runId: "run",
    threadId: thread,
    ruleId: "rule",
    summary: "Pushed without review",
    detail: "DETAIL ".repeat(500),
    confidence: 0.8,
    evidence: Array.from({ length: 5 }, (_, index) => ({
      threadId: thread,
      messageId: MessageId.make(`message-${index}`),
      excerpt: "x".repeat(900),
    })),
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-14T00:00:00Z",
    exchanges: [],
    outcome: null,
  });
  assert.include(text, "Observation: Pushed without review");
  assert.include(text, "Rule: Verify changes");
  assert.include(text, 'respond_monitoring_advisory({findingId:"finding"');
  assert.notInclude(text, "RULE-INSTRUCTIONS");
  assert.notInclude(text, "DETAIL");
  assert.equal(text.match(/^- message /gm)?.length, 3);
  assert.isAtMost(text.length, 1200);
});

it("posts an assessment back in at most 600 characters", () => {
  const text = monitoringFollowup(
    { ...profile, title: "T".repeat(500) },
    `Assessment: unresolved\nReason: ${"because ".repeat(400)}`,
  );
  assert.isAtMost(text.length, 600);
  assert.include(text, "Assessment: unresolved\nReason: because");
  assert.include(text, "Full assessment in the inbox");
});

it("clips without splitting a character made of two code units", () => {
  const clipped = clip(`ab${"😀".repeat(5)}`, 6);
  assert.isTrue(clipped.isWellFormed());
  assert.isAtMost(clipped.length, 6);
});
