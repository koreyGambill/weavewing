import type { EvidenceLanding, EvidenceProjectCoverage, EvidenceQaState } from "@t3tools/contracts";
import { CheckIcon, CircleDashedIcon, CircleIcon, MinusIcon, WrenchIcon } from "lucide-react";

/** Every QA state; the user sets only the ones marked `user`, and the agent records a problem. */
export const QA_STATES = [
  {
    state: "pending",
    label: "Open",
    icon: CircleDashedIcon,
    tone: "text-warning-foreground",
    user: true,
  },
  {
    state: "confirmed",
    label: "Confirmed",
    icon: CheckIcon,
    tone: "text-success-foreground",
    user: true,
  },
  {
    state: "problem",
    label: "Agent fixing",
    icon: WrenchIcon,
    tone: "text-warning-foreground",
    user: false,
  },
  {
    state: "waived",
    label: "Dismissed",
    icon: MinusIcon,
    tone: "text-muted-foreground",
    user: true,
  },
  {
    state: "quiet",
    label: "Nothing to check",
    icon: CircleIcon,
    tone: "text-muted-foreground",
    user: false,
  },
] as const;

const CLAIMS = { approved: "approved", changes_requested: "changes requested" } as const;

export const CHECKS = {
  pass: { suffix: "", variant: "success" },
  fail: { suffix: " failed", variant: "error" },
  skipped: { suffix: " skipped", variant: "outline" },
} as const;

/** A check's badge text, with the reason a skipped one gives. Older records have none. */
export function checkLabel(check: {
  readonly label: string;
  readonly result: keyof typeof CHECKS;
  readonly reason?: string | undefined;
}): string {
  const base = `${check.label}${CHECKS[check.result].suffix}`;
  return check.result === "skipped" && check.reason ? `${base}: ${check.reason}` : base;
}

type LandingReview = EvidenceLanding["changes"][number]["review"];

export type ReviewLink =
  | {
      readonly kind: "reviewer" | "linked";
      readonly label: string;
      readonly threadId: NonNullable<LandingReview["threadId"]>;
    }
  | { readonly kind: "unavailable"; readonly label: string; readonly description: string };

/**
 * How a change's review reads. Nothing checks a reviewer's verdict yet, so every claim reads as
 * the agent's unverified word. The server says what a linked thread is now; a server that predates
 * that says nothing, and the link stays a neutral one that still opens the thread.
 */
export function reviewDisplay(review: LandingReview): {
  readonly label: string;
  readonly hint: string | null;
  readonly link: ReviewLink | null;
} {
  if (review.verdict === "waived")
    return {
      label: review.reason ? `review waived: ${review.reason}` : "review waived",
      hint: null,
      link: null,
    };
  const claim = CLAIMS[review.verdict];
  return {
    label: `Unverified review · agent reported ${claim}`,
    hint: `Reported ${claim}${review.by ? ` by ${review.by}` : ""}. Reviewer verdicts are not checked yet.`,
    link: review.threadId === undefined ? null : reviewLink(review.threadId, review.thread),
  };
}

function reviewLink(
  threadId: NonNullable<LandingReview["threadId"]>,
  thread: LandingReview["thread"],
): ReviewLink {
  switch (thread) {
    case "reviewer":
      return { kind: "reviewer", label: "Reviewer", threadId };
    case "archived":
      return {
        kind: "unavailable",
        label: "Linked thread archived",
        description: "The linked thread is archived. Find it under Settings, Archived.",
      };
    case "missing":
      return {
        kind: "unavailable",
        label: "Linked thread unavailable",
        description: "The linked thread was deleted or is not in this environment.",
      };
    default:
      return { kind: "linked", label: "Linked thread", threadId };
  }
}

export function captureKind(path: string): "image" | "video" | "file" {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)) return "image";
  if (["webm", "mp4", "mov", "m4v"].includes(extension)) return "video";
  return "file";
}

/** Whether a landing drops out of the Needs QA list once this change takes `next`. */
export function leavesNeedsQa(
  changes: ReadonlyArray<{ readonly id: string; readonly qa: { readonly state: EvidenceQaState } }>,
  changeId: string,
  next: EvidenceQaState,
): boolean {
  return changes.every((change) => {
    const state = change.id === changeId ? next : change.qa.state;
    return state === "confirmed" || state === "waived" || state === "quiet";
  });
}

export function coverageDraft(
  existing: string,
  coverage: Pick<EvidenceProjectCoverage, "branch" | "uncovered" | "uncoveredCount">,
): string {
  const more = coverage.uncoveredCount - coverage.uncovered.length;
  const message = [
    `These merges on ${coverage.branch} have no evidence. Record it with evidence_record, or tell me why none is needed:`,
    ...coverage.uncovered.map(({ sha, subject }) => `- ${sha.slice(0, 10)} ${subject}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
  ].join("\n");
  return appendDraft(existing, message);
}

const appendDraft = (existing: string, message: string) =>
  existing.trim() ? `${existing.trimEnd()}\n\n${message}` : message;
