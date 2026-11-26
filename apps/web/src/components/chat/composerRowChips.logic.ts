import type {
  ScheduledTaskId,
  ScheduledTaskSummary,
  ThreadId,
  VcsStatusResult,
} from "@t3tools/contracts";
import type { ThreadPullRequestBadge } from "@t3tools/client-runtime/thread-pull-requests";

import { resolveDisplayedThreadPr } from "../ThreadStatusIndicators";

/**
 * The open pull request found for the thread's branch, for a thread whose shell links none. The
 * row's branch picker can show a ref the thread has not recorded yet, such as while a checkout
 * is in flight; until the two agree, the branch's pull request may belong to the other ref.
 */
export function resolveComposerRowBranchPullRequest(input: {
  readonly threadBranch: string | null;
  /** The ref the row's branch picker shows; undefined while no picker shows one. */
  readonly pickerBranch: string | null | undefined;
  readonly gitStatus: Pick<VcsStatusResult, "refName" | "pr"> | null;
}) {
  if (input.pickerBranch !== undefined && input.pickerBranch !== input.threadBranch) return null;
  return resolveDisplayedThreadPr({ threadBranch: input.threadBranch, gitStatus: input.gitStatus });
}

/** What the pull request chip reads: `#42`, and how many more the thread links. */
export interface ComposerRowPullRequestText {
  readonly primary: string;
  readonly more: number;
  /** The chip's whole value, such as `#42 +2`, shared by the chip and its ⋯ row. */
  readonly value: string;
}

/** The chip's text for the PR the thread shows, or null when it shows none. */
export function resolveComposerRowPullRequestText(input: {
  readonly badge: ThreadPullRequestBadge | null;
  readonly number: number | undefined;
}): ComposerRowPullRequestText | null {
  const { badge, number } = input;
  if (number === undefined) {
    if (badge?.kind !== "stack") return null;
    const primary = String(badge.layers);
    return { primary, more: 0, value: primary };
  }
  const more = badge === null ? 0 : badge.kind === "stack" ? badge.layers - 1 : badge.others;
  const primary = `#${number}`;
  return { primary, more, value: more > 0 ? `${primary} +${more}` : primary };
}

export interface ComposerRowAutomation {
  readonly id: ScheduledTaskId;
  readonly title: string;
  /** `started` for the automation that created the thread, `targets` for one that sends to it. */
  readonly relation: "started" | "targets";
  /** False while the automation is paused. */
  readonly enabled: boolean;
}

/**
 * The automations tied to a thread that still exist: the one that started it first, then each
 * task that sends to it, once each. `tasks` is null until the environment's list arrives, and a
 * starter that list does not hold has been deleted, so neither offers a chip that opens nothing.
 */
export function resolveThreadAutomations(input: {
  readonly threadId: ThreadId;
  readonly startedByTaskId: ScheduledTaskId | null | undefined;
  readonly tasks: ReadonlyArray<
    Pick<ScheduledTaskSummary, "id" | "title" | "threadId" | "enabled">
  > | null;
}): ReadonlyArray<ComposerRowAutomation> {
  const { threadId, startedByTaskId, tasks } = input;
  if (tasks === null) return [];
  const starter = startedByTaskId ? tasks.find((task) => task.id === startedByTaskId) : undefined;
  const started: ReadonlyArray<ComposerRowAutomation> = starter
    ? [{ id: starter.id, title: starter.title, relation: "started", enabled: starter.enabled }]
    : [];
  const targeting = tasks
    .filter((task) => task.threadId === threadId && task.id !== startedByTaskId)
    .map((task) => ({
      id: task.id,
      title: task.title,
      relation: "targets" as const,
      enabled: task.enabled,
    }));
  return [...started, ...targeting];
}

export interface ComposerRowAutomationsSummary {
  readonly title: string;
  readonly more: number;
  /** The chip's whole value, such as `nightly +1`, shared by the chip and its ⋯ row. */
  readonly value: string;
  /** For the tooltip and accessible name. */
  readonly description: string;
}

export function summarizeComposerRowAutomations(
  automations: ReadonlyArray<ComposerRowAutomation>,
): ComposerRowAutomationsSummary | null {
  const [first, ...rest] = automations;
  if (first === undefined) return null;
  const more = rest.length;
  return {
    title: first.title,
    more,
    value: more > 0 ? `${first.title} +${more}` : first.title,
    description:
      more > 0
        ? `Automations: ${automations.map((automation) => automation.title).join(", ")}`
        : `Automation: ${first.title}, ${automationRelationLabel(first).toLowerCase()}`,
  };
}

/** How an automation relates to the thread, and whether it is paused. */
export function automationRelationLabel(
  automation: Pick<ComposerRowAutomation, "relation" | "enabled">,
): string {
  const relation = automation.relation === "started" ? "Started this thread" : "Sends here";
  return automation.enabled ? relation : `${relation} · paused`;
}
