import type { MonitoringReviewOutput } from "@t3tools/contracts";
import { repeatsKnownIncident } from "../../apps/server/src/monitoring/findingDedupe.ts";
import { filed, snapshotFor, type Case } from "./cases.ts";

type Finding = MonitoringReviewOutput["findings"][number];

/** The findings the runner would file, after it drops the ones that repeat a known incident. */
export const survivors = (entry: Case, findings: ReadonlyArray<Finding>) => {
  const snapshot = snapshotFor(entry);
  const kept: Array<Finding> = [];
  for (const finding of findings)
    if (!repeatsKnownIncident(finding, snapshot, [filed], kept)) kept.push(finding);
  return kept;
};

/** A repeat case passes when nothing is filed; a new case when a finding cites a new message. */
export const grade = (entry: Case, findings: ReadonlyArray<Finding>) => {
  const fresh = new Set(
    entry.messages.filter((message) => !message.priorContext).map((message) => message.id),
  );
  if (entry.kind === "repeat")
    return findings.length === 0
      ? { pass: true, reason: "nothing filed" }
      : { pass: false, reason: `filed ${findings.length}` };
  return findings.some((finding) => finding.evidence.some((item) => fresh.has(item.messageId)))
    ? { pass: true, reason: "filed the new incident" }
    : { pass: false, reason: "missed the new incident" };
};
