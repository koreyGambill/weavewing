import {
  DEFAULT_REVIEW_TARGETS,
  MAX_REVIEW_INSTRUCTION_FILES,
  MAX_REVIEW_RULES,
  ReviewInstructionFile,
  type MonitoringRule,
  type ReviewTargets,
  type ScheduledTaskReviewAgent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** A review agent as the automation editor edits it. */
export interface ReviewDraft {
  readonly kind: ScheduledTaskReviewAgent["kind"];
  readonly rules: ReadonlyArray<MonitoringRule>;
  /** One path per line. */
  readonly instructionFiles: string;
  readonly includeProjectAgents: boolean;
  readonly targets: ReviewTargets;
  /** Comma or newline separated. */
  readonly threadIds: string;
  readonly delivery: ScheduledTaskReviewAgent["delivery"];
}

export const newReviewDraft = (ruleId: string): ReviewDraft => ({
  kind: "standards",
  rules: [
    {
      id: ruleId,
      title: "Follow project standards",
      instructions:
        "Compare the thread's recent work with its repository instructions and applicable standards. Report only evidence-backed deviations, cite the exact message, and explain uncertainty.",
    },
  ],
  instructionFiles: "",
  includeProjectAgents: false,
  targets: DEFAULT_REVIEW_TARGETS,
  threadIds: "",
  delivery: "thread-or-alert",
});

export const reviewDraftFromAgent = (agent: ScheduledTaskReviewAgent): ReviewDraft => ({
  kind: agent.kind,
  rules: agent.rules,
  instructionFiles: (agent.instructionFiles ?? []).join("\n"),
  includeProjectAgents: agent.includeProjectAgents === true,
  targets: agent.targets,
  threadIds: agent.targets.threadIds.join(", "),
  delivery: agent.delivery,
});

const isInstructionFile = Schema.is(ReviewInstructionFile);
const splitList = (value: string, separator: RegExp) =>
  value
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);

export function reviewAgentFromDraft(
  draft: ReviewDraft,
): { readonly agent: ScheduledTaskReviewAgent } | { readonly error: string } {
  const rules = draft.rules.map((rule) => ({
    id: rule.id,
    title: rule.title.trim(),
    instructions: rule.instructions.trim(),
  }));
  if (rules.length === 0 || rules.length > MAX_REVIEW_RULES)
    return { error: `Add between 1 and ${MAX_REVIEW_RULES} rules.` };
  if (rules.some((rule) => !rule.title || !rule.instructions))
    return { error: "Give every rule a title and instructions." };
  const files = splitList(draft.instructionFiles, /\n/);
  if (files.length > MAX_REVIEW_INSTRUCTION_FILES)
    return { error: `Use at most ${MAX_REVIEW_INSTRUCTION_FILES} instruction files.` };
  const relative = files.find((file) => !isInstructionFile(file));
  if (relative !== undefined)
    return { error: `Use an absolute or ~/ path for instruction file ${relative}.` };
  return {
    agent: {
      type: "review",
      kind: draft.kind,
      rules,
      ...(files.length === 0 ? {} : { instructionFiles: files }),
      ...(draft.includeProjectAgents ? { includeProjectAgents: true } : {}),
      targets: {
        ...draft.targets,
        threadIds: splitList(draft.threadIds, /[\s,]+/) as Array<ThreadId>,
      },
      delivery: draft.delivery,
    },
  };
}
