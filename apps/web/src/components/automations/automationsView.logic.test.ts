import { type ScheduledTask, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { automationHomeThread, automationSections, runCostLabel } from "./automationsView.logic";

const task = (id: string, fields: Partial<Record<keyof ScheduledTask, unknown>> = {}) =>
  ({
    id,
    title: `Task ${id}`,
    prompt: "Check things",
    enabled: true,
    projectId: "project:a",
    threadId: null,
    schedule: { type: "event", event: "run_ended" },
    ...fields,
  }) as unknown as ScheduledTask;

const thread = { threadId: "thread:1", projectId: "project:a", lineage: ["thread:1"] };
const options = { scope: "thread", thread, filter: "", showPaused: true } as const;
const ids = (rows: ReadonlyArray<{ task: ScheduledTask }>) => rows.map((row) => row.task.id);

describe("automationSections", () => {
  const tasks = [
    task("bound", { threadId: "thread:1", schedule: { type: "interval", everyMs: 60_000 } }),
    task("event"),
    task("off", { disabledThreadIds: ["thread:1"] }),
    task("daily", { schedule: { type: "fixed_time", timeOfDay: "07:00" } }),
    task("elsewhere", { projectId: "project:b", schedule: { type: "interval", everyMs: 60_000 } }),
    task("paused", { enabled: false }),
  ];

  it("splits the thread's automations into on and off, leaving out ones that never reach it", () => {
    const sections = automationSections(tasks, options);
    expect(ids(sections.on)).toEqual(["bound", "event", "paused"]);
    expect(ids(sections.off)).toEqual(["off"]);
  });

  it("lists the project's or every automation outside thread scope", () => {
    expect(ids(automationSections(tasks, { ...options, scope: "project" }).on)).toEqual([
      "bound",
      "event",
      "off",
      "daily",
      "paused",
    ]);
    const server = automationSections(tasks, { ...options, scope: "server", thread: null });
    expect(server.on).toHaveLength(6);
  });

  it("filters by title or prompt and can hide paused ones", () => {
    const filtered = automationSections(tasks, { ...options, scope: "server", filter: "task d" });
    expect(ids(filtered.on)).toEqual(["daily"]);
    const active = automationSections(tasks, { ...options, scope: "server", showPaused: false });
    expect(ids(active.on)).not.toContain("paused");
  });

  it("folds finished one-time schedules out of the active inventory", () => {
    const runAt = "2026-11-19T20:00:00.000Z";
    const schedule = { type: "once", runAt };
    const once = (id: string, fields: Partial<ScheduledTask>) =>
      task(id, {
        schedule,
        nextRunAt: null,
        lastRunAt: runAt,
        lastRunStatus: "succeeded",
        ...fields,
      });
    const scheduled = [
      once("finished", {}),
      once("running", { lastRunStatus: "running" }),
      once("manual-before-due", { lastRunAt: "2026-11-19T19:00:00.000Z", nextRunAt: runAt }),
      once("paused-before-due", {
        enabled: false,
        lastRunAt: "2026-11-19T19:00:00.000Z",
      }),
    ];
    const server = { ...options, scope: "server", thread: null } as const;
    const all = automationSections(scheduled, server);
    expect(ids(all.completed)).toEqual(["finished"]);
    expect(ids(all.on)).toEqual(["running", "manual-before-due", "paused-before-due"]);
    const active = automationSections(scheduled, { ...server, showPaused: false });
    expect(ids(active.on)).toEqual(["running", "manual-before-due"]);
    expect(active.completed).toEqual([]);
  });
});

it("opens the kept thread, or the newest run's thread for new-thread automations", () => {
  const runs = [null, "thread:run-2", "thread:run-1"].map((id) => ({
    threadId: id === null ? null : ThreadId.make(id),
  }));
  const kept = { threadId: ThreadId.make("thread:kept"), threadMode: "continue" } as const;
  const perRun = { threadId: null, threadMode: "new_thread" } as const;
  expect(automationHomeThread(kept, runs)).toBe("thread:kept");
  expect(automationHomeThread(perRun, runs)).toBe("thread:run-2");
  expect(automationHomeThread(perRun, [])).toBeNull();
});

it("prices a run with its subagent estimate marked as approximate", () => {
  expect(runCostLabel({})).toBeNull();
  expect(runCostLabel({ costUsd: 0.12 })).toBe("$0.12");
  expect(runCostLabel({ costUsd: 0.1, otherCostUsdEstimate: 0.05 })).toBe("~$0.15");
  expect(runCostLabel({ costUsd: 0.001 })).toBe("$<0.01");
});
