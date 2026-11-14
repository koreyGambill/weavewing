import type { MonitoringFinding, MonitoringReviewOutput } from "@t3tools/contracts";
import type { MonitoringSnapshotData } from "./MonitoringSnapshot.ts";

type Candidate = MonitoringReviewOutput["findings"][number];
type Prior = Pick<MonitoringFinding, "threadId" | "evidence" | "outcome">;

const RESOLVED = new Set(["corrected", "accepted_explanation"]);
const cited = (evidence: Candidate["evidence"]) =>
  new Set(evidence.map((item) => `${item.threadId}\0${item.messageId}`));

/**
 * Whether a new review's finding repeats an incident already filed for its thread: it cites only
 * messages an earlier review saw, or shares evidence with an open finding. After a correction or
 * accepted explanation, it counts as new only when it also cites messages that finding did not.
 */
export function repeatsKnownIncident(
  candidate: Candidate,
  snapshot: MonitoringSnapshotData,
  prior: ReadonlyArray<Prior>,
): boolean {
  const priorContext = candidate.evidence.every((item) =>
    snapshot.threads.some(
      (thread) =>
        thread.id === item.threadId &&
        thread.messages.some((message) => message.id === item.messageId && message.priorContext),
    ),
  );
  if (priorContext) return true;
  const keys = cited(candidate.evidence);
  return prior.some((finding) => {
    if (finding.threadId !== candidate.threadId) return false;
    const old = cited(finding.evidence);
    return finding.outcome !== null && RESOLVED.has(finding.outcome)
      ? [...keys].every((key) => old.has(key))
      : [...keys].some((key) => old.has(key));
  });
}
