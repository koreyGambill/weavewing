import type { MonitoringFinding, MonitoringReviewOutput } from "@t3tools/contracts";
import type { MonitoringSnapshotData } from "./MonitoringSnapshot.ts";

type Candidate = MonitoringReviewOutput["findings"][number];
type Filed = Pick<MonitoringFinding, "threadId" | "evidence">;

const key = (item: { readonly threadId: string; readonly messageId: string }) =>
  `${item.threadId}\0${item.messageId}`;
const citedBy = (findings: ReadonlyArray<Filed>, threadId: string) =>
  new Set(
    findings.filter((finding) => finding.threadId === threadId).flatMap((f) => f.evidence.map(key)),
  );

/**
 * Whether a review's finding repeats an incident already filed for its thread. Messages an earlier
 * review saw (prior context, or evidence of the thread's earlier findings) cannot make a finding
 * new. A finding is a repeat when it cites nothing else, or when it shares one of its new messages
 * with a finding this review already filed.
 */
export function repeatsKnownIncident(
  candidate: Candidate,
  snapshot: MonitoringSnapshotData,
  prior: ReadonlyArray<Filed>,
  raised: ReadonlyArray<Filed>,
): boolean {
  const seen = citedBy(prior, candidate.threadId);
  for (const thread of snapshot.threads)
    for (const message of thread.messages)
      if (message.priorContext) seen.add(key({ threadId: thread.id, messageId: message.id }));
  const fresh = candidate.evidence.map(key).filter((item) => !seen.has(item));
  const filedNow = citedBy(raised, candidate.threadId);
  return fresh.length === 0 || fresh.some((item) => filedNow.has(item));
}
