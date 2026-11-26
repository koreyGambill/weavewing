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

/** What the collapsed strip says: per-kind counts and how many wait on the agent instead. */
export interface WaitingStripSummary {
  readonly counts: ReadonlyArray<{ readonly kind: WaitingItemKind; readonly count: number }>;
  readonly discussing: number;
  readonly total: number;
}

/** Null when nothing waits on the user and nothing is being discussed, so the strip hides. */
export function waitingStripSummary(
  waiting: ReadonlyArray<WaitingItemSummary> | undefined,
  counts: WaitingCounts | undefined,
): WaitingStripSummary | null {
  const discussing = (waiting ?? []).filter((item) => item.state === "discussing").length;
  const total = waitingTotal(counts);
  if (total === 0 && discussing === 0) return null;
  return {
    counts: WAITING_KINDS.flatMap((kind) =>
      counts !== undefined && counts[kind] > 0 ? [{ kind, count: counts[kind] }] : [],
    ),
    discussing,
    total,
  };
}

/** The thread's still-waiting items by kind, in the strip's order; empty kinds are left out. */
export function groupWaitingItems(
  waiting: ReadonlyArray<WaitingItemSummary> | undefined,
): ReadonlyArray<{
  readonly kind: WaitingItemKind;
  readonly items: ReadonlyArray<WaitingItemSummary>;
}> {
  const live = (waiting ?? []).filter((item) => isWaitingItemState(item.state));
  return WAITING_KINDS.flatMap((kind) => {
    const items = live.filter((item) => item.kind === kind);
    return items.length === 0 ? [] : [{ kind, items }];
  });
}

/** `landingId/changeId` back into its parts; null for a key that has no change id. */
export function qaKeyParts(
  key: string,
): { readonly landingId: string; readonly changeId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { landingId: key.slice(0, slash), changeId: key.slice(slash + 1) };
}

/** The row chip's accessible label, such as "3 waiting on you: 1 question, 2 tasks". */
export function waitingChipLabel(counts: WaitingCounts): string {
  const parts = WAITING_KINDS.flatMap((kind) =>
    counts[kind] > 0
      ? [
          `${counts[kind]} ${counts[kind] === 1 ? WAITING_KIND_LABEL[kind].one : WAITING_KIND_LABEL[kind].many}`,
        ]
      : [],
  );
  return `${waitingTotal(counts)} waiting on you: ${parts.join(", ")}`;
}

/**
 * Changes whenever a question or task in the mirror changes, so the thread's workspace read
 * follows them; QA changes live elsewhere and leave it alone.
 */
export const waitingRefreshKey = (waiting: ReadonlyArray<WaitingItemSummary> | undefined) =>
  (waiting ?? [])
    .filter((item) => item.kind !== "qa")
    .map((item) => `${item.ref}:${item.state}:${item.sent === true}`)
    .join(",");
