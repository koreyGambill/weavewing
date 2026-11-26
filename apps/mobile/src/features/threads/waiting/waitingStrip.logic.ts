import {
  isWaitingItemState,
  waitingTotal,
  type WaitingCounts,
  type WaitingItemKind,
  type WaitingItemSummary,
} from "@t3tools/contracts";

const WAITING_KINDS: ReadonlyArray<WaitingItemKind> = ["question", "qa", "task"];

export const WAITING_KIND_LABEL: Record<WaitingItemKind, { one: string; many: string }> = {
  question: { one: "question", many: "questions" },
  qa: { one: "change to check", many: "changes to check" },
  task: { one: "task", many: "tasks" },
};

export const WAITING_KIND_HEADING: Record<WaitingItemKind, string> = {
  question: "Questions",
  qa: "QA",
  task: "Tasks",
};

export interface WaitingSummary {
  readonly counts: ReadonlyArray<{ readonly kind: WaitingItemKind; readonly count: number }>;
  readonly discussing: number;
  readonly total: number;
  /** Items still waiting that the thread's capped rows do not list. */
  readonly unlisted: number;
}

/**
 * What the strip says, or null when nothing waits on the user and nothing is being discussed.
 * Every number comes from the exact counts, never from how many rows the thread lists.
 */
export function waitingSummary(
  rows: ReadonlyArray<WaitingItemSummary> | undefined,
  counts: WaitingCounts | undefined,
): WaitingSummary | null {
  if (counts === undefined) return null;
  const live = (rows ?? []).filter((row) => isWaitingItemState(row.state));
  // An older server omits `discussing` and `live`; the rows stand in for the first, and without
  // the second nothing claims that rows are missing.
  const discussing = counts.discussing ?? live.filter((row) => row.state === "discussing").length;
  const total = waitingTotal(counts);
  if (total === 0 && discussing === 0) return null;
  return {
    counts: WAITING_KINDS.flatMap((kind) =>
      counts[kind] > 0 ? [{ kind, count: counts[kind] }] : [],
    ),
    discussing,
    total,
    unlisted: counts.live === undefined ? 0 : Math.max(0, counts.live - live.length),
  };
}

/** The still-waiting rows by kind, in the strip's order; empty kinds are left out. */
export function groupWaitingRows(
  rows: ReadonlyArray<WaitingItemSummary> | undefined,
): ReadonlyArray<{
  readonly kind: WaitingItemKind;
  readonly items: ReadonlyArray<WaitingItemSummary>;
}> {
  const live = (rows ?? []).filter((row) => isWaitingItemState(row.state));
  return WAITING_KINDS.flatMap((kind) => {
    const items = live.filter((item) => item.kind === kind);
    return items.length === 0 ? [] : [{ kind, items }];
  });
}

/** Per-kind counts in words, such as "1 question, 2 tasks". */
export function waitingCountsPhrase(counts: WaitingCounts): string {
  return WAITING_KINDS.flatMap((kind) =>
    counts[kind] > 0
      ? [
          `${counts[kind]} ${counts[kind] === 1 ? WAITING_KIND_LABEL[kind].one : WAITING_KIND_LABEL[kind].many}`,
        ]
      : [],
  ).join(", ");
}

/** A thread row's spoken waiting count, such as "3 waiting on you: 1 question, 2 tasks". */
export function waitingBadgeLabel(counts: WaitingCounts | undefined): string | null {
  const total = waitingTotal(counts);
  return counts === undefined || total === 0
    ? null
    : `${total} waiting on you: ${waitingCountsPhrase(counts)}`;
}

/** Why a listed row is not counted as waiting on the user, if it is not. */
export function waitingRowNote(row: WaitingItemSummary): string | null {
  if (row.sent === true) return "Answer queued";
  if (row.state === "deferred") return "Deferred";
  if (row.state === "discussing") return "Discussing";
  if (row.state === "problem") return "Agent fixing";
  return null;
}

/** `landingId/changeId` back into its parts; null for a key without a change id. */
export function qaKeyParts(
  key: string,
): { readonly landingId: string; readonly changeId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { landingId: key.slice(0, slash), changeId: key.slice(slash + 1) };
}
