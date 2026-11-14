import type { EvidenceChange, EvidenceQaState } from "@t3tools/contracts";

export const QA_STATES: ReadonlyArray<{
  readonly state: EvidenceQaState;
  readonly label: string;
  readonly dot: string;
}> = [
  { state: "pending", label: "Pending", dot: "bg-warning" },
  { state: "confirmed", label: "Confirmed", dot: "bg-success" },
  { state: "failed", label: "Failed", dot: "bg-destructive" },
  { state: "waived", label: "Waived", dot: "bg-muted-foreground" },
];

export function captureKind(path: string): "image" | "video" | "file" {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)) return "image";
  if (["webm", "mp4", "mov", "m4v"].includes(extension)) return "video";
  return "file";
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
  return existing.trim() ? `${existing.trimEnd()}\n\n${message}` : message;
}
