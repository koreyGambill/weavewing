import type {
  EnvironmentId,
  EvidenceLanding,
  EvidenceLandingSummary,
  EvidenceListResult,
  EvidenceQaState,
  WaitingCounts,
} from "@t3tools/contracts";

/** A connected environment that records evidence and lets this connection read it. */
export interface EvidenceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * How many threads have changes waiting on the user's QA, from each thread's exact count in the
 * shell stream. It counts threads, never changes: a sum of changes across threads grows past
 * anything a person can act on. Archived threads are absent from the stream and wait on nobody.
 */
export function evidenceThreadsWaitingCount(
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly archivedAt: string | null;
    readonly waitingCounts?: WaitingCounts | undefined;
  }>,
  environmentIds: ReadonlySet<EnvironmentId>,
): number {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      environmentIds.has(thread.environmentId) &&
      (thread.waitingCounts?.qa ?? 0) > 0,
  ).length;
}

/** "3 threads have changes to check"; null when none does. */
export function threadsWaitingPhrase(threads: number): string | null {
  if (threads <= 0) return null;
  return `${threads} ${threads === 1 ? "thread has" : "threads have"} changes to check`;
}

export function evidenceButtonLabel(threadsWaiting: number): string {
  const phrase = threadsWaitingPhrase(threadsWaiting);
  return phrase === null ? "Evidence" : `Evidence, ${phrase}`;
}

/** Web's QA state words and order, as its Evidence view counts them on a landing. */
const TALLY_LABELS: ReadonlyArray<{ readonly state: EvidenceQaState; readonly label: string }> = [
  { state: "pending", label: "open" },
  { state: "confirmed", label: "confirmed" },
  { state: "problem", label: "agent fixing" },
  { state: "waived", label: "dismissed" },
  { state: "quiet", label: "nothing to check" },
];

/** A landing's QA in words, such as "2 open · 1 confirmed · 3 changes". */
export function landingQaSummary(
  landing: Pick<EvidenceLandingSummary, "qa" | "changeCount">,
): string {
  return [
    ...TALLY_LABELS.flatMap(({ state, label }) =>
      landing.qa[state] > 0 ? [`${landing.qa[state]} ${label}`] : [],
    ),
    `${landing.changeCount} ${landing.changeCount === 1 ? "change" : "changes"}`,
  ].join(" · ");
}

/** "main · 0123456": where a landing went. */
export const landingTargetLine = (landing: Pick<EvidenceLandingSummary, "target">) =>
  `${landing.target.branch} · ${landing.target.sha.slice(0, 7)}`;

/** The thread that shows a landing's QA, where Discuss writes: the lead, for a delegate's landing. */
export const landingQaThreadId = (landing: Pick<EvidenceLanding, "threadId" | "qaThreadId">) =>
  landing.qaThreadId ?? landing.threadId;

/**
 * Which list a group reads: the server's Needs QA filter, or every landing, unfiltered, as web's
 * "All landings" shows them. A landing that needs QA shows in both; filtering the second by the
 * QA tally would hide one whose only pending change the user is discussing, which Needs QA leaves
 * out while the tally still counts it as pending.
 */
export type EvidenceGroup = "needs-qa" | "all";

/** One environment's first pages: null until they load. */
export interface EvidenceFirstPages {
  readonly needsQa: EvidenceListResult | null;
  readonly all: EvidenceListResult | null;
}

export type EvidenceSheetState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "listed";
      /** Every environment answered and none has a landing that needs QA. */
      readonly needsQaEmpty: boolean;
      /** Every environment answered and none has a landing at all. */
      readonly allEmpty: boolean;
    };

/**
 * What the sheet shows: a load in progress, the empty state once every environment has answered
 * with no landings, or the groups. An environment whose read failed shows its own error in the
 * groups, so it never makes the sheet or a group read as empty.
 */
export function evidenceSheetState(
  environments: ReadonlyArray<EvidenceFirstPages & { readonly failed: boolean }>,
): EvidenceSheetState {
  const failed = environments.some((entry) => entry.failed);
  const needsQaAnswered = !failed && environments.every((entry) => entry.needsQa !== null);
  const allAnswered = !failed && environments.every((entry) => entry.all !== null);
  const needsQaListed = environments.some((entry) => (entry.needsQa?.items.length ?? 0) > 0);
  const allListed = environments.some((entry) => (entry.all?.items.length ?? 0) > 0);
  if (!failed && !needsQaListed && !allListed) {
    return needsQaAnswered && allAnswered ? { kind: "empty" } : { kind: "loading" };
  }
  return {
    kind: "listed",
    needsQaEmpty: needsQaAnswered && !needsQaListed,
    allEmpty: allAnswered && !allListed,
  };
}

/** The heading each environment's lists sit under; none when only one is listed. */
export const evidenceEnvironmentHeading = (
  environment: EvidenceEnvironment,
  environmentCount: number,
): string | null => (environmentCount > 1 ? environment.label : null);
