import type { EvidenceChange, EvidenceProjectCoverage, EvidenceQaState } from "@t3tools/contracts";
import { CheckIcon, CircleDashedIcon, MinusIcon, XIcon } from "lucide-react";

export const QA_STATES = [
  { state: "pending", label: "Pending", icon: CircleDashedIcon, tone: "text-warning-foreground" },
  { state: "confirmed", label: "Confirmed", icon: CheckIcon, tone: "text-success-foreground" },
  { state: "failed", label: "Failed", icon: XIcon, tone: "text-destructive-foreground" },
  { state: "waived", label: "Waived", icon: MinusIcon, tone: "text-muted-foreground" },
] as const;

const VERDICTS = {
  approved: { label: "approved", variant: "success" },
  changes_requested: { label: "changes requested", variant: "warning" },
  waived: { label: "review waived", variant: "outline" },
} as const;

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

/**
 * How a change's review reads. Only a review the server checked against a finished reviewer
 * thread shows as reviewed; any other verdict is the agent's word and shows as unverified.
 */
export function reviewDisplay(review: EvidenceChange["review"]): {
  readonly label: string;
  readonly variant: "success" | "warning" | "outline";
  readonly hint: string | null;
  readonly threadId: EvidenceChange["review"]["threadId"] | null;
} {
  const by = review.by ? ` by ${review.by}` : "";
  if (review.verdict === "waived")
    return {
      label: review.reason ? `review waived: ${review.reason}` : "review waived",
      variant: "outline",
      hint: null,
      threadId: null,
    };
  const verdict = VERDICTS[review.verdict];
  const linked =
    review.linked === "derived" ? " The reviewer thread was linked automatically." : "";
  if (review.check === "verdict_unconfirmed" && review.threadId !== undefined)
    return {
      label: "verdict not confirmed",
      variant: "outline",
      hint: `Reported ${verdict.label}${by}; the reviewer thread does not state one plain verdict.${linked}`,
      threadId: review.threadId,
    };
  if (review.check !== "verified" || review.threadId === undefined)
    return {
      label: "unverified review",
      variant: "outline",
      hint: `Reported ${verdict.label}${by}, with no finished reviewer thread behind it.`,
      threadId: null,
    };
  return {
    label: `${verdict.label}${review.by ? ` · ${review.by}` : ""}`,
    variant: verdict.variant,
    hint: linked === "" ? null : linked.trim(),
    threadId: review.threadId,
  };
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
    return state === "confirmed" || state === "waived";
  });
}

/** The failed-QA message for the landing's thread, added after any draft already there. */
export function failedQaDraft(
  existing: string,
  change: Pick<EvidenceChange, "id" | "ask" | "ticket">,
  note: string,
): string {
  const ask = change.ask.split("\n", 1)[0]!.trim();
  const message = [
    `QA failed on ${change.ticket?.key ?? change.id}: ${note.trim() || "(no note)"}`,
    `Ask: ${ask}`,
  ].join("\n");
  return appendDraft(existing, message);
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
