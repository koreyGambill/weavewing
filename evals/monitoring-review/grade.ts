import type { MonitoringReviewOutput } from "@t3tools/contracts";
import type { Case } from "./cases.ts";

/** A repeat case passes when nothing is filed; a new case when a finding cites a new message. */
export const grade = (entry: Case, output: MonitoringReviewOutput) => {
  const fresh = new Set(
    entry.messages.filter((message) => !message.priorContext).map((message) => message.id),
  );
  if (entry.kind === "repeat")
    return output.findings.length === 0
      ? { pass: true, reason: "nothing filed" }
      : { pass: false, reason: `filed ${output.findings.length}` };
  return output.findings.some((finding) =>
    finding.evidence.some((item) => fresh.has(item.messageId)),
  )
    ? { pass: true, reason: "filed the new incident" }
    : { pass: false, reason: "missed the new incident" };
};
