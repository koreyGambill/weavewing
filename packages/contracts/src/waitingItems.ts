import * as Effect from "effect/Effect";
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

/**
 * Exact numbers for a thread's waiting items, which stay right when the listed rows are capped.
 * `question`, `qa` and `task` count items waiting on the user: `open` and not `sent`.
 */
export const WaitingCounts = Schema.Struct({
  question: NonNegativeInt,
  qa: NonNegativeInt,
  task: NonNegativeInt,
  // A thread stored before these three were kept reads zero until the next rebuild, at startup.
  /** Items the user is discussing, which wait on the agent. */
  discussing: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Questions still waiting on someone: open, sent, deferred or discussing. */
  liveQuestions: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Every item still waiting on someone, of any kind; rows past the cap are this minus those listed. */
  live: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type WaitingCounts = typeof WaitingCounts.Type;

/** The most waiting rows a thread lists for display; counts stay exact past it. */
export const WAITING_ITEMS_LIMIT = 30;

const WAITING_KINDS: ReadonlyArray<WaitingItemKind> = ["question", "qa", "task"];

/** Open, deferred, discussing and problem items are still waiting on someone. */
export const isWaitingItemState = (state: WaitingItemState): boolean =>
  state === "open" || state === "deferred" || state === "discussing" || state === "problem";

/** Whether the item counts as waiting on the user. */
const waitingOnUser = (item: WaitingItemSummary): boolean =>
  item.state === "open" && item.sent !== true;

const waitingItemCounts = (items: ReadonlyArray<WaitingItemSummary>): WaitingCounts => {
  const counts = { question: 0, qa: 0, task: 0, discussing: 0, liveQuestions: 0, live: 0 };
  for (const item of items) {
    if (!isWaitingItemState(item.state)) continue;
    counts.live += 1;
    if (waitingOnUser(item)) counts[item.kind] += 1;
    if (item.state === "discussing") counts.discussing += 1;
    if (item.kind === "question") counts.liveQuestions += 1;
  }
  return counts;
};

export const waitingTotal = (counts: WaitingCounts | undefined): number =>
  counts === undefined ? 0 : counts.question + counts.qa + counts.task;

export const sameWaitingCounts = (a: WaitingCounts | undefined, b: WaitingCounts | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.question === b.question &&
    a.qa === b.qa &&
    a.task === b.task &&
    a.discussing === b.discussing &&
    a.liveQuestions === b.liveQuestions &&
    a.live === b.live);

// What a capped list keeps first: what waits on the user, then on the agent, then set aside.
const capRank = (item: WaitingItemSummary) =>
  waitingOnUser(item) ? 0 : item.state === "discussing" || item.state === "problem" ? 1 : 2;

const byKindThenOrder = <T extends { readonly item: WaitingItemSummary; readonly index: number }>(
  a: T,
  b: T,
) => WAITING_KINDS.indexOf(a.item.kind) - WAITING_KINDS.indexOf(b.item.kind) || a.index - b.index;

/** At most `limit` of the items still waiting, preferring what waits on the user, grouped by kind. */
function capWaiting(
  items: ReadonlyArray<WaitingItemSummary>,
  limit: number,
): ReadonlyArray<WaitingItemSummary> {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isWaitingItemState(item.state))
    .sort((a, b) => capRank(a.item) - capRank(b.item) || a.index - b.index)
    .slice(0, limit)
    .sort(byKindThenOrder)
    .map(({ item }) => item);
}

/**
 * The thread's mirror from every item its three stores report. Server logic reads its questions,
 * so every question is kept, closed ones the user changed included; QA changes and tasks still
 * waiting are capped at `WAITING_ITEMS_LIMIT`, because only the display reads them.
 */
export function waitingMirror(items: ReadonlyArray<WaitingItemSummary>): {
  readonly waiting: ReadonlyArray<WaitingItemSummary>;
  readonly waitingCounts: WaitingCounts;
} {
  const others = new Set(
    capWaiting(
      items.filter((item) => item.kind !== "question"),
      WAITING_ITEMS_LIMIT,
    ),
  );
  return {
    waiting: items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.kind === "question" || others.has(item))
      .sort(byKindThenOrder)
      .map(({ item }) => item),
    waitingCounts: waitingItemCounts(items),
  };
}

/** The rows a thread lists for display: at most `WAITING_ITEMS_LIMIT` still waiting. */
export const waitingDisplayRows = (
  waiting: ReadonlyArray<WaitingItemSummary>,
): ReadonlyArray<WaitingItemSummary> => capWaiting(waiting, WAITING_ITEMS_LIMIT);

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
