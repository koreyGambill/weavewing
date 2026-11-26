import type { ScheduledTask, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import type { ThreadPullRequestBadge } from "@t3tools/client-runtime/thread-pull-requests";

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
}

const UNTITLED_AUTOMATION = "Automation";

/**
 * The automations tied to a thread: the one that started it first, then each task that sends to
 * it, once each. `tasks` is null while the environment's list is unavailable.
 */
export function resolveThreadAutomations(input: {
  readonly threadId: ThreadId;
  readonly startedByTaskId: ScheduledTaskId | null | undefined;
  readonly tasks: ReadonlyArray<Pick<ScheduledTask, "id" | "title" | "threadId">> | null;
}): ReadonlyArray<ComposerRowAutomation> {
  const { threadId, startedByTaskId, tasks } = input;
  const started: ReadonlyArray<ComposerRowAutomation> = startedByTaskId
    ? [
        {
          id: startedByTaskId,
          title: tasks?.find((task) => task.id === startedByTaskId)?.title ?? UNTITLED_AUTOMATION,
          relation: "started",
        },
      ]
    : [];
  const targeting = (tasks ?? [])
    .filter((task) => task.threadId === threadId && task.id !== startedByTaskId)
    .map((task) => ({ id: task.id, title: task.title, relation: "targets" as const }));
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
        : `Automation: ${first.title}, ${automationRelationLabel(first.relation).toLowerCase()}`,
  };
}

export function automationRelationLabel(relation: ComposerRowAutomation["relation"]): string {
  return relation === "started" ? "Started this thread" : "Sends here";
}
