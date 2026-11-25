import type { OrchestrationV2ThreadQuestionSummary } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

type DismissalEntry = Extract<TimelineEntry, { readonly kind: "question-dismissed" }>;

/** The user's dismissals among a thread's mirrored questions, as timeline entries. */
export function questionDismissalEntries(
  questions: ReadonlyArray<OrchestrationV2ThreadQuestionSummary> | undefined,
): ReadonlyArray<DismissalEntry> {
  return (questions ?? []).flatMap((question) =>
    question.state === "withdrawn" && question.userChangedAt !== undefined
      ? [
          {
            id: `question-dismissed:${question.id}`,
            kind: "question-dismissed" as const,
            createdAt: question.userChangedAt,
            runId: null,
            questionId: question.id,
            title: question.title,
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
