import type { EvidenceChange, EvidenceProjectCoverage, EvidenceQaState } from "@t3tools/contracts";
import { CheckIcon, CircleDashedIcon, MinusIcon, XIcon } from "lucide-react";

export const QA_STATES = [
  { state: "pending", label: "Pending", icon: CircleDashedIcon, tone: "text-warning-foreground" },
  { state: "confirmed", label: "Confirmed", icon: CheckIcon, tone: "text-success-foreground" },
  { state: "failed", label: "Failed", icon: XIcon, tone: "text-destructive-foreground" },
  { state: "waived", label: "Waived", icon: MinusIcon, tone: "text-muted-foreground" },
] as const;

export const VERDICTS = {
  approved: { label: "approved", variant: "success" },
  changes_requested: { label: "changes requested", variant: "warning" },
  waived: { label: "review waived", variant: "outline" },
} as const;

export const CHECKS = {
  pass: { suffix: "", variant: "success" },
  fail: { suffix: " failed", variant: "error" },
  skipped: { suffix: " skipped", variant: "outline" },
} as const;

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

/** Asks the lead to record evidence for merges that have none, after any draft already there. */
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
