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

import type { ProviderInstanceEntry } from "../../providerInstances";

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

/** Switching the review kind drops rules left blank; the first stays so the list is never empty. */
export const withKind = (draft: ReviewDraft, kind: ReviewDraft["kind"]): ReviewDraft => {
  const filled = draft.rules.filter((rule) => rule.title.trim() || rule.instructions.trim());
  return { ...draft, kind, rules: filled.length > 0 ? filled : draft.rules.slice(0, 1) };
};

/** `data-review-field` value of the control to focus for a failed review draft. */
export const reviewFieldKey = {
  ruleTitle: (id: string) => `rule-title:${id}`,
  ruleInstructions: (id: string) => `rule-instructions:${id}`,
  instructionFiles: "instruction-files",
} as const;

export function reviewAgentFromDraft(
  draft: ReviewDraft,
):
  | { readonly agent: ScheduledTaskReviewAgent }
  | { readonly error: string; readonly field?: string } {
  const rules = draft.rules.map((rule) => ({
    id: rule.id,
    title: rule.title.trim(),
    instructions: rule.instructions.trim(),
  }));
  if (rules.length === 0 || rules.length > MAX_REVIEW_RULES)
    return { error: `Add between 1 and ${MAX_REVIEW_RULES} rules.` };
  for (const [index, rule] of rules.entries()) {
    if (!rule.title)
      return {
        error: `Rule ${index + 1} needs a title.`,
        field: reviewFieldKey.ruleTitle(rule.id),
      };
    if (!rule.instructions)
      return {
        error: `Rule ${index + 1} needs instructions.`,
        field: reviewFieldKey.ruleInstructions(rule.id),
      };
  }
  const files = splitList(draft.instructionFiles, /\n/);
  if (files.length > MAX_REVIEW_INSTRUCTION_FILES)
    return {
      error: `Use at most ${MAX_REVIEW_INSTRUCTION_FILES} instruction files.`,
      field: reviewFieldKey.instructionFiles,
    };
  const relative = files.find((file) => !isInstructionFile(file));
  if (relative !== undefined)
    return {
      error: `Use an absolute or ~/ path for instruction file ${relative}.`,
      field: reviewFieldKey.instructionFiles,
    };
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

/** Reviews read whole transcripts on every run, so a new one starts on Claude Haiku when it is ready. */
export function reviewModelKey(
  entries: ReadonlyArray<
    Pick<ProviderInstanceEntry, "instanceId" | "driverKind" | "enabled" | "isAvailable" | "models">
  >,
): string | null {
  for (const entry of entries) {
    if (entry.driverKind !== "claudeAgent" || !entry.enabled || !entry.isAvailable) continue;
    const haiku = entry.models.find((model) => /haiku/i.test(model.slug));
    if (haiku) return `${entry.instanceId}:${haiku.slug}`;
  }
  return null;
}
