import {
  automationAppliesTo,
  automationOffForThread,
  type AutomationThreadContext,
} from "@t3tools/client-runtime/automations";
import {
  scheduledTaskThreadMode,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";

export type AutomationStatusFilter = "all" | "active" | "paused";

export interface AutomationRowModel {
  readonly task: ScheduledTask;
  /** "event" rows switch on and off for the open thread; others pause the whole automation. */
  readonly applies: "bound" | "event" | null;
}

export interface AutomationSections {
  readonly on: ReadonlyArray<AutomationRowModel>;
  /** Thread scope only: automations switched off for the open thread. */
  readonly off: ReadonlyArray<AutomationRowModel>;
  readonly completed: ReadonlyArray<AutomationRowModel>;
}

function matchesFilter(task: ScheduledTask, filter: string) {
  const needle = filter.trim().toLowerCase();
  return (
    needle === "" ||
    task.title.toLowerCase().includes(needle) ||
    task.prompt.toLowerCase().includes(needle)
  );
}

function isCompletedOnce(task: ScheduledTask): boolean {
  return (
    task.schedule.type === "once" &&
    task.nextRunAt === null &&
    task.lastRunStatus !== "running" &&
    task.lastRunAt !== null &&
    Date.parse(task.lastRunAt) >= Date.parse(task.schedule.runAt)
  );
}

/** Rows for one environment's automations in the chosen scope. */
export function automationSections(
  tasks: ReadonlyArray<ScheduledTask>,
  options: {
    readonly thread: AutomationThreadContext | null;
    readonly filter: string;
    readonly status: AutomationStatusFilter;
  },
): AutomationSections {
  const on: AutomationRowModel[] = [];
  const off: AutomationRowModel[] = [];
  const completed: AutomationRowModel[] = [];
  const { thread } = options;
  for (const task of tasks) {
    if (!matchesFilter(task, options.filter)) continue;
    const applies = thread === null ? null : automationAppliesTo(task, thread);
    if (thread !== null && applies === null) continue;
    const finished = isCompletedOnce(task);
    const offHere =
      applies === "event" && thread !== null && automationOffForThread(task, thread.threadId);
    const active = task.enabled && !offHere;
    if (options.status !== "all" && (finished || active !== (options.status === "active")))
      continue;
    const row = { task, applies };
    if (finished) completed.push(row);
    else if (offHere) off.push(row);
    else on.push(row);
  }
  return { on, off, completed };
}

/** Where "Open thread" goes: the thread a one-thread automation keeps, or the newest run's. */
export function automationHomeThread(
  task: Pick<ScheduledTask, "threadId" | "threadMode">,
  runs: ReadonlyArray<Pick<ScheduledTaskRun, "threadId">>,
): string | null {
  if (scheduledTaskThreadMode(task) !== "new_thread" && task.threadId !== null) {
    return task.threadId;
  }
  return runs.find((run) => run.threadId !== null)?.threadId ?? null;
}

export const THREAD_MODE_LABELS = {
  new_thread: "New thread per run",
  continue: "Continues one thread",
  fresh_session: "One thread, fresh session per run",
} as const;

/** The run's whole price: the main agent's, plus the estimate for subagents and compaction. */
export function runCostLabel(
  run: Pick<ScheduledTaskRun, "costUsd" | "otherCostUsdEstimate">,
): string | null {
  if (run.costUsd === undefined && run.otherCostUsdEstimate === undefined) return null;
  const total = (run.costUsd ?? 0) + (run.otherCostUsdEstimate ?? 0);
  const estimated = (run.otherCostUsdEstimate ?? 0) > 0 ? "~" : "";
  return `${estimated}$${total > 0 && total < 0.01 ? "<0.01" : total.toFixed(2)}`;
}

const COMPACT_EVENT_LABELS = {
  run_ended: "On turn end",
  thread_created: "On new thread",
  thread_settled: "On thread settled",
  status_transition: "On status change",
} as const;

/** A row's short trigger, as the 212 px list fits it; null falls back to the full label. */
export function compactScheduleLabel(schedule: ScheduledTaskSchedule): string | null {
  switch (schedule.type) {
    case "event":
      return COMPACT_EVENT_LABELS[schedule.event];
    case "webhook":
      return "On webhook";
    case "interval": {
      if (schedule.wakeWhen !== undefined) return null;
      if (schedule.idleCheckin) return "When idle 30m";
      const minutes = schedule.everyMs / 60_000;
      if (!Number.isInteger(minutes)) return null;
      return minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes}m`;
    }
    case "fixed_time": {
      const weekdays = schedule.weekdays ?? [];
      return weekdays.length === 0 ? `Daily ${schedule.timeOfDay}` : null;
    }
    case "once":
      return null;
  }
}
