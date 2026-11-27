import {
  isWaitingItemState,
  waitingTotal,
  type WaitingCounts,
  type WaitingItemKind,
  type WaitingItemSummary,
  type ThreadWorkspace,
  type WaitingItemContextRecord,
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

/** What the strip says: per-kind counts, discussions, and rows the capped list leaves out. */
export interface WaitingStripSummary {
  readonly counts: ReadonlyArray<{ readonly kind: WaitingItemKind; readonly count: number }>;
  readonly discussing: number;
  readonly answersToRead?: number;
  readonly owedAnswers?: number;
  readonly total: number;
  /** Items still waiting that the thread's capped rows do not list. */
  readonly unlisted: number;
  /** Any question still waits on someone, so the questions panel has something to show. */
  readonly hasQuestions: boolean;
}

export const waitingTotalWithAnswers = (counts: WaitingCounts | undefined) =>
  waitingTotal(counts) + (counts?.answer ?? 0);

/**
 * Null when nothing waits on the user and nothing is being discussed, so the strip hides. Every
 * number comes from the exact counts, never from how many rows the thread lists.
 */
export function waitingStripSummary(
  rows: ReadonlyArray<WaitingItemSummary> | undefined,
  counts: WaitingCounts | undefined,
  listedAnswers = 0,
): WaitingStripSummary | null {
  if (counts === undefined) return null;
  const live = (rows ?? []).filter((row) => isWaitingItemState(row.state));
  // Counts stored before these numbers were kept lack them until the startup rebuild; the rows
  // then stand in, as they did before the numbers existed.
  const discussing = counts.discussing ?? live.filter((row) => row.state === "discussing").length;
  const total = waitingTotalWithAnswers(counts);
  const owedAnswers = counts.owed ?? 0;
  if (total === 0 && discussing === 0 && owedAnswers === 0) return null;
  return {
    counts: WAITING_KINDS.flatMap((kind) =>
      counts[kind] > 0 ? [{ kind, count: counts[kind] }] : [],
    ),
    discussing,
    ...(counts.answer ? { answersToRead: counts.answer } : {}),
    ...(owedAnswers ? { owedAnswers } : {}),
    total,
    unlisted:
      Math.max(0, (counts.live ?? live.length) - live.length) +
      Math.max(0, (counts.answer ?? 0) + owedAnswers - listedAnswers),
    hasQuestions: hasLiveQuestions(rows, counts),
  };
}

/** Any question still waits on someone, from the exact count or, before it exists, the rows. */
export const hasLiveQuestions = (
  rows: ReadonlyArray<WaitingItemSummary> | undefined,
  counts: WaitingCounts | undefined,
): boolean =>
  counts?.liveQuestions === undefined
    ? (rows ?? []).some((row) => row.kind === "question" && isWaitingItemState(row.state))
    : counts.liveQuestions > 0;

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
  if (counts.answer) parts.push(`${counts.answer} ${counts.answer === 1 ? "answer" : "answers"}`);
  return `${waitingTotalWithAnswers(counts)} waiting on you: ${parts.join(", ")}`;
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

/**
 * The composer's Discuss references without those for questions and tasks that no longer wait
 * on the user, read from a workspace snapshot; null when every reference still applies. QA
 * references are left alone, since the workspace does not hold QA.
 */
export function discussesStillWaiting(
  records: ReadonlyArray<WaitingItemContextRecord>,
  workspace: Pick<ThreadWorkspace, "questions" | "items">,
): WaitingItemContextRecord[] | null {
  const kept = records.filter((record) => {
    if (record.itemKind === "question")
      return workspace.questions.some(
        (question) =>
          question.id === record.key &&
          (question.state === "open" || question.state === "deferred") &&
          question.sentInMessageId === undefined,
      );
    if (record.itemKind === "task")
      return workspace.items.some(
        (item) => item.id === record.key && item.owner === "you" && item.state === "open",
      );
    return true;
  });
  return kept.length === records.length ? null : kept;
}
