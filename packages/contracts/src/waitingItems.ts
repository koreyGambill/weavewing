import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What waits on the user: an agent's question, a landed change's QA, or a task only the user can do. */
export const WaitingItemKind = Schema.Literals(["question", "qa", "task"]);
export type WaitingItemKind = typeof WaitingItemKind.Type;

/** What the user sees; each kind maps its own storage onto these. */
export const WaitingItemState = Schema.Literals([
  /** Waiting on the user. */
  "open",
  /** Question only: set aside, out of the count. */
  "deferred",
  /** The user sent a message about it; waiting on the agent. */
  "discussing",
  /** Answered, confirmed or done. */
  "settled",
  /** QA only: the user reported a problem; the agent owes a fix. */
  "problem",
  /** Closed without an answer; for a task, cancelled. */
  "dismissed",
  /** Question only. */
  "replaced",
]);
export type WaitingItemState = typeof WaitingItemState.Type;

export const WaitingItemSummary = Schema.Struct({
  kind: WaitingItemKind,
  /** Per-thread display ref such as Q3, QA1 or T2, assigned by the owning store and never reused. */
  ref: TrimmedNonEmptyString,
  /** The owning store's identity: question id, `${landingId}/${changeId}`, or list item id. */
  key: TrimmedNonEmptyString,
  title: Schema.String,
  state: WaitingItemState,
  settledBy: Schema.optional(Schema.Literals(["user", "agent"])),
  /** A user message carries its answer and its turn has not finished, so it waits on nobody. */
  sent: Schema.optional(Schema.Literal(true)),
  /** Question only: discussed after the user deferred it, so the agent hears both. */
  deferred: Schema.optional(Schema.Literal(true)),
  /** When the user last deferred, dismissed or reopened it. */
  userChangedAt: Schema.optional(IsoDateTime),
});
export type WaitingItemSummary = typeof WaitingItemSummary.Type;

/** Items waiting on the user per kind: `open` and not `sent`. Exact even when the list is capped. */
export const WaitingCounts = Schema.Struct({
  question: NonNegativeInt,
  qa: NonNegativeInt,
  task: NonNegativeInt,
});
export type WaitingCounts = typeof WaitingCounts.Type;

/** The most waiting items a thread carries; counts stay exact past it. */
export const WAITING_ITEMS_LIMIT = 30;

const WAITING_KINDS: ReadonlyArray<WaitingItemKind> = ["question", "qa", "task"];

/** Open, deferred, discussing and problem items are still waiting on someone. */
export const isWaitingItemState = (state: WaitingItemState): boolean =>
  state === "open" || state === "deferred" || state === "discussing" || state === "problem";

/** Whether the item counts as waiting on the user. */
export const waitingOnUser = (item: WaitingItemSummary): boolean =>
  item.state === "open" && item.sent !== true;

const waitingItemCounts = (items: ReadonlyArray<WaitingItemSummary>): WaitingCounts => {
  const counts = { question: 0, qa: 0, task: 0 };
  for (const item of items) if (waitingOnUser(item)) counts[item.kind] += 1;
  return counts;
};

export const waitingTotal = (counts: WaitingCounts | undefined): number =>
  counts === undefined ? 0 : counts.question + counts.qa + counts.task;

// What a capped list keeps first: what waits on the user, then on the agent, then set aside.
const capRank = (item: WaitingItemSummary) =>
  waitingOnUser(item) ? 0 : item.state === "discussing" || item.state === "problem" ? 1 : 2;

/**
 * The thread's mirror from every item its three stores report: the waiting ones, capped at
 * `WAITING_ITEMS_LIMIT` and grouped by kind, then closed items the user changed, which the agent
 * hears about on its next user turn.
 */
export function waitingMirror(items: ReadonlyArray<WaitingItemSummary>): {
  readonly waiting: ReadonlyArray<WaitingItemSummary>;
  readonly waitingCounts: WaitingCounts;
} {
  const indexed = items.map((item, index) => ({ item, index }));
  const kept = new Set(
    indexed
      .filter(({ item }) => isWaitingItemState(item.state))
      .sort((a, b) => capRank(a.item) - capRank(b.item) || a.index - b.index)
      .slice(0, WAITING_ITEMS_LIMIT)
      .map(({ index }) => index),
  );
  const byKind = (entry: { readonly item: WaitingItemSummary; readonly index: number }) =>
    WAITING_KINDS.indexOf(entry.item.kind);
  return {
    waiting: [
      ...indexed.filter(({ index }) => kept.has(index)),
      ...indexed.filter(({ item }) => !isWaitingItemState(item.state)),
    ]
      .sort(
        (a, b) =>
          Number(!isWaitingItemState(a.item.state)) - Number(!isWaitingItemState(b.item.state)) ||
          byKind(a) - byKind(b) ||
          a.index - b.index,
      )
      .map(({ item }) => item),
    waitingCounts: waitingItemCounts(items),
  };
}

const sameItem = (a: WaitingItemSummary, b: WaitingItemSummary) =>
  a.kind === b.kind &&
  a.ref === b.ref &&
  a.key === b.key &&
  a.title === b.title &&
  a.state === b.state &&
  a.settledBy === b.settledBy &&
  a.sent === b.sent &&
  a.deferred === b.deferred &&
  a.userChangedAt === b.userChangedAt;

export const sameWaitingItems = (
  a: ReadonlyArray<WaitingItemSummary>,
  b: ReadonlyArray<WaitingItemSummary>,
): boolean => a.length === b.length && a.every((item, index) => sameItem(item, b[index]!));
