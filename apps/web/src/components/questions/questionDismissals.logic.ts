import type { WaitingItemSummary } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

type DismissalEntry = Extract<TimelineEntry, { readonly kind: "question-dismissed" }>;

/** The user's dismissals among a thread's mirrored questions, as timeline entries. */
export function questionDismissalEntries(
  waiting: ReadonlyArray<WaitingItemSummary> | undefined,
): ReadonlyArray<DismissalEntry> {
  return (waiting ?? []).flatMap((item) =>
    item.kind === "question" && item.state === "dismissed" && item.userChangedAt !== undefined
      ? [
          {
            id: `question-dismissed:${item.ref}`,
            kind: "question-dismissed" as const,
            createdAt: item.userChangedAt,
            runId: null,
            questionId: item.ref,
            title: item.title,
          },
        ]
      : [],
  );
}

/**
 * `entries` with each dismissal placed where it happened. While older history is still to load,
 * one older than every loaded entry waits for it, so it never lands at the top out of order.
 */
export function withQuestionDismissals(
  entries: ReadonlyArray<TimelineEntry>,
  dismissals: ReadonlyArray<DismissalEntry>,
  historyComplete: boolean,
): ReadonlyArray<TimelineEntry> {
  const first = entries[0];
  const placed = dismissals.filter(
    (dismissal) => historyComplete || first === undefined || dismissal.createdAt >= first.createdAt,
  );
  if (placed.length === 0) return entries;
  const merged: TimelineEntry[] = [];
  const pending = placed.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const entry of entries) {
    while (pending.length > 0 && pending[0]!.createdAt < entry.createdAt)
      merged.push(pending.shift()!);
    merged.push(entry);
  }
  merged.push(...pending);
  return merged;
}
