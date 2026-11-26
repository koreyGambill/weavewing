import type {
  EnvironmentId,
  EvidenceLanding,
  EvidenceLandingSummary,
  EvidenceListResult,
  EvidenceQaState,
  EvidenceQaTally,
  WaitingCounts,
} from "@t3tools/contracts";

/** A connected environment that records evidence and lets this connection read it. */
export interface EvidenceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Changes waiting on the user's QA across the listed environments, summed from each thread's
 * exact counts, which the shell stream keeps current. Archived threads are left out, since the
 * phone does not list them; landings never stand in, because their pages are capped.
 */
export function evidenceAwaitingCount(
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly archivedAt: string | null;
    readonly waitingCounts?: WaitingCounts | undefined;
  }>,
  environmentIds: ReadonlySet<EnvironmentId>,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null || !environmentIds.has(thread.environmentId)) continue;
    count += thread.waitingCounts?.qa ?? 0;
  }
  return count;
}

export function evidenceButtonLabel(awaiting: number): string {
  if (awaiting <= 0) return "Evidence";
  return `Evidence, ${awaiting} ${awaiting === 1 ? "change awaits" : "changes await"} your QA`;
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

/** The server's Needs QA rule: a change still pending, or a problem the agent owes. */
export const landingNeedsQa = (tally: EvidenceQaTally) => tally.pending + tally.problem > 0;

/** "main · 0123456": where a landing went. */
export const landingTargetLine = (landing: Pick<EvidenceLandingSummary, "target">) =>
  `${landing.target.branch} · ${landing.target.sha.slice(0, 7)}`;

/** The thread that shows a landing's QA, where Discuss writes: the lead, for a delegate's landing. */
export const landingQaThreadId = (landing: Pick<EvidenceLanding, "threadId" | "qaThreadId">) =>
  landing.qaThreadId ?? landing.threadId;

/** Which group a page of landings fills: the Needs QA list, or everything else. */
export type EvidenceGroup = "needs-qa" | "landed";

/**
 * The landings a group shows from one page. The Landed group reads the unfiltered list, so it
 * drops what Needs QA already lists, and no landing shows twice.
 */
export function groupLandings(
  group: EvidenceGroup,
  items: ReadonlyArray<EvidenceLandingSummary>,
): ReadonlyArray<EvidenceLandingSummary> {
  return group === "needs-qa" ? items : items.filter((landing) => !landingNeedsQa(landing.qa));
}

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
      /** Every environment answered and none has another landing, on this page or older. */
      readonly landedEmpty: boolean;
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
  const landedListed = environments.some(
    (entry) =>
      entry.all !== null &&
      (entry.all.next !== null || groupLandings("landed", entry.all.items).length > 0),
  );
  if (!failed && !needsQaListed && !landedListed) {
    return needsQaAnswered && allAnswered ? { kind: "empty" } : { kind: "loading" };
  }
  return {
    kind: "listed",
    needsQaEmpty: needsQaAnswered && !needsQaListed,
    landedEmpty: allAnswered && !landedListed,
  };
}

/** The heading each environment's lists sit under; none when only one is listed. */
export const evidenceEnvironmentHeading = (
  environment: EvidenceEnvironment,
  environmentCount: number,
): string | null => (environmentCount > 1 ? environment.label : null);
