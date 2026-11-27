import type { ScheduledTask } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { automationAppliesTo, runOutcomeLabel } from "./automations.ts";

const thread = {
  threadId: "thread:child",
  projectId: "project:a",
  lineage: ["thread:child", "thread:root"],
};
const event = (fields: Record<string, unknown>) =>
  ({
    threadId: null,
    schedule: { type: "event", event: "run_ended", ...fields },
  }) as unknown as Pick<ScheduledTask, "threadId" | "schedule">;

it.each([
  [
    "bound to the thread",
    { threadId: "thread:child", schedule: { type: "interval", everyMs: 60_000 } },
    "bound",
  ],
  [
    "an unbound schedule",
    { threadId: null, schedule: { type: "interval", everyMs: 60_000 } },
    null,
  ],
  ["status events", event({ event: "status_transition" }), null],
  ["every thread", event({}), "event"],
  ["its project", event({ projectId: "project:a" }), "event"],
  ["another project", event({ projectId: "project:b" }), null],
  ["listed threads", event({ threadIds: ["thread:child"] }), "event"],
  ["an ancestor without descendants", event({ threadIds: ["thread:root"] }), null],
  [
    "an ancestor with descendants",
    event({ threadIds: ["thread:root"], includeDescendants: true }),
    "event",
  ],
] as const)("an automation for %s applies as %s", (_name, task, expected) => {
  expect(automationAppliesTo(task as Pick<ScheduledTask, "threadId" | "schedule">, thread)).toBe(
    expected,
  );
});

it.each([
  [{ status: "skipped", skipCount: 3 }, "Skipped ×3"],
  [{ status: "budget_stopped" }, "Stopped at its budget"],
  [{ status: "new_outcome" }, "new outcome"],
])("labels recorded automation outcomes (%j)", (run, label) => {
  expect(runOutcomeLabel(run)).toBe(label);
});
