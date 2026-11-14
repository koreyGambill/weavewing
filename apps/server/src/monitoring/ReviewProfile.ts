import type {
  ModelSelection,
  MonitoringRule,
  ProjectId,
  ReviewTargets,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskReviewAgent,
} from "@t3tools/contracts";

/** A review automation as the review pipeline reads it. */
export interface ReviewProfile {
  readonly id: ScheduledTaskId;
  readonly title: string;
  readonly kind: ScheduledTaskReviewAgent["kind"];
  readonly enabled: boolean;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  /** Runs on turn ends, so a finding may start the reviewed thread's next turn. */
  readonly turnEnd: boolean;
  readonly delivery: ScheduledTaskReviewAgent["delivery"];
  readonly instructionFiles?: ReadonlyArray<string> | undefined;
  readonly includeProjectAgents?: boolean | undefined;
  readonly targets: ReviewTargets;
  readonly rules: ReadonlyArray<MonitoringRule>;
}

export function reviewProfile(task: ScheduledTask): ReviewProfile | null {
  const agent = task.agent;
  if (agent?.type !== "review") return null;
  return {
    id: task.id,
    title: task.title,
    kind: agent.kind,
    enabled: task.enabled,
    projectId: task.projectId,
    modelSelection: task.modelSelection,
    turnEnd: task.schedule.type === "event" && task.schedule.event === "run_ended",
    delivery: agent.delivery,
    instructionFiles: agent.instructionFiles,
    includeProjectAgents: agent.includeProjectAgents,
    targets: agent.targets,
    rules: agent.rules,
  };
}
