import {
  scheduledTaskEventMatchesProject,
  type ScheduledTask,
  type ScheduledTaskRun,
} from "@t3tools/contracts";

export interface AutomationThreadContext {
  readonly threadId: string;
  readonly projectId: string;
  /** The thread itself first, then its ancestors, nearest first. */
  readonly lineage: ReadonlyArray<string>;
}

/**
 * How an automation reaches a thread: bound to it, or through its event filter. Mirrors the
 * server's event matching; status events and unbound schedules belong to no thread.
 */
export function automationAppliesTo(
  task: Pick<ScheduledTask, "threadId" | "schedule">,
  thread: AutomationThreadContext,
): "bound" | "event" | null {
  if (task.threadId === thread.threadId) return "bound";
  const schedule = task.schedule;
  if (schedule.type !== "event" || schedule.event === "status_transition") return null;
  if (!scheduledTaskEventMatchesProject(schedule, thread.projectId)) return null;
  if (schedule.threadIds === undefined || schedule.threadIds.length === 0) return "event";
  const watched = new Set<string>(schedule.threadIds);
  const matches =
    schedule.includeDescendants === true
      ? thread.lineage.some((id) => watched.has(id))
      : watched.has(thread.threadId);
  return matches ? "event" : null;
}

export function automationOffForThread(
  task: Pick<ScheduledTask, "disabledThreadIds">,
  threadId: string,
): boolean {
  return task.disabledThreadIds?.some((id) => id === threadId) ?? false;
}

const RUN_OUTCOME_LABELS: Record<string, string> = {
  running: "Running",
  quiet: "Quiet",
  notified: "Notified",
  suppressed: "Suppressed",
  failed: "Failed",
  skipped: "Skipped",
  budget_stopped: "Stopped at its budget",
  capped: "Over its hourly cap",
};

export function runOutcomeLabel(run: Pick<ScheduledTaskRun, "status" | "skipCount">): string {
  const label = RUN_OUTCOME_LABELS[run.status] ?? run.status.split("_").join(" ");
  return run.status === "skipped" && (run.skipCount ?? 1) > 1
    ? `${label} ×${run.skipCount}`
    : label;
}
