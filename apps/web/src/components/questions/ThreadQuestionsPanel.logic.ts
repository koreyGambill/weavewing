import * as Schema from "effect/Schema";
import type { ThreadQuestion } from "@t3tools/contracts";
import { sectionThreadQuestions } from "@t3tools/client-runtime/state/thread-questions";

/** The panel's list order: Waiting, then Deferred, then Closed. */
export function questionPanelOrder<Q extends Pick<ThreadQuestion, "id" | "state" | "closedAt">>(
  questions: ReadonlyArray<Q>,
): Q[] {
  const sections = sectionThreadQuestions(questions);
  return [...sections.waiting, ...sections.deferred, ...sections.closed];
}

/** The selection to show: the kept one while it exists, else the first waiting question. */
export function resolveSelectedQuestionId(
  order: ReadonlyArray<Pick<ThreadQuestion, "id">>,
  selectedId: string | null,
): string | null {
  if (selectedId !== null && order.some((question) => question.id === selectedId))
    return selectedId;
  return order[0]?.id ?? null;
}

export type QuestionPanelKeyAction =
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "choose"; readonly id: string; readonly chosenOptionIds: string[] }
  | { readonly type: "defer"; readonly id: string }
  | { readonly type: "close" };

/**
 * The keys the panel handles, as `aria-keyshortcuts`, so type-to-focus leaves them out of the
 * composer.
 */
export const QUESTION_PANEL_KEY_SHORTCUTS = "J K N 1 2 3 4 5 6 7 8 9 Escape";

/** J/K move, 1–9 choose or clear an option, N defers, Escape closes the panel. */
export function questionPanelKeyAction(input: {
  readonly key: string;
  readonly order: ReadonlyArray<
    Pick<ThreadQuestion, "id" | "state" | "options" | "multiSelect" | "answer" | "sentInMessageId">
  >;
  readonly selectedId: string | null;
}): QuestionPanelKeyAction | null {
  const { key, order } = input;
  if (key === "Escape") return { type: "close" };
  const index = order.findIndex((question) => question.id === input.selectedId);
  const selected = order[index];
  const lower = key.toLowerCase();
  if (lower === "j" || lower === "k") {
    const next = order[index === -1 ? 0 : index + (lower === "j" ? 1 : -1)];
    return next === undefined ? null : { type: "select", id: next.id };
  }
  if (selected === undefined) return null;
  // A sent answer stays as sent until its message is edited or cancelled.
  const answerable =
    (selected.state === "open" || selected.state === "deferred") &&
    selected.sentInMessageId === undefined;
  if (lower === "n")
    return selected.state === "open" && answerable ? { type: "defer", id: selected.id } : null;
  if (!answerable || !/^[1-9]$/.test(key)) return null;
  const option = selected.options[Number(key) - 1];
  if (option === undefined) return null;
  const chosen = selected.answer?.chosenOptionIds ?? [];
  return {
    type: "choose",
    id: selected.id,
    chosenOptionIds: selected.multiSelect
      ? chosen.includes(option.id)
        ? chosen.filter((id) => id !== option.id)
        : [...chosen, option.id]
      : chosen.includes(option.id)
        ? []
        : [option.id],
  };
}

/**
 * The question the panel's column is on: the focused one while any of it shows, so a jump to a
 * card near the end sticks, else the first card reaching below the column's top.
 */
export function questionInView(
  cards: ReadonlyArray<{ readonly id: string; readonly top: number; readonly bottom: number }>,
  view: { readonly top: number; readonly bottom: number },
  focusedId: string | null,
): string | null {
  const visible = (card: (typeof cards)[number]) =>
    card.bottom > view.top && card.top < view.bottom;
  const focused = cards.find((card) => card.id === focusedId);
  if (focused !== undefined && visible(focused)) return focused.id;
  return cards.find((card) => card.bottom > view.top + 8)?.id ?? null;
}

/** The panel's filter chips. A replaced question goes with Dismissed: neither got an answer. */
export const QUESTION_FILTERS = ["waiting", "deferred", "answered", "dismissed"] as const;
export type QuestionFilter = (typeof QUESTION_FILTERS)[number];
export const DEFAULT_QUESTION_FILTERS: ReadonlyArray<QuestionFilter> = ["waiting", "deferred"];
/** Remembered per device, so every thread's panel opens on the same filters. */
export const QUESTION_FILTERS_STORAGE_KEY = "t3code:questions-panel-filters:v1";
export const QuestionFiltersSchema = Schema.Array(Schema.Literals(QUESTION_FILTERS));

function questionFilterOf(question: Pick<ThreadQuestion, "state">): QuestionFilter {
  switch (question.state) {
    case "open":
      return "waiting";
    case "deferred":
      return "deferred";
    case "answered":
      return "answered";
    case "withdrawn":
    case "replaced":
      return "dismissed";
  }
}

export function questionFilterCounts(
  questions: ReadonlyArray<Pick<ThreadQuestion, "state">>,
): Record<QuestionFilter, number> {
  const counts: Record<QuestionFilter, number> = {
    waiting: 0,
    deferred: 0,
    answered: 0,
    dismissed: 0,
  };
  for (const question of questions) counts[questionFilterOf(question)]++;
  return counts;
}

export function filterQuestions<Q extends Pick<ThreadQuestion, "state">>(
  questions: ReadonlyArray<Q>,
  filters: ReadonlyArray<QuestionFilter>,
): Q[] {
  return questions.filter((question) => filters.includes(questionFilterOf(question)));
}

/** `filters` with `filter` switched, in chip order, so the stored value is stable. */
export function toggleQuestionFilter(
  filters: ReadonlyArray<QuestionFilter>,
  filter: QuestionFilter,
): QuestionFilter[] {
  const on = new Set(filters);
  if (on.has(filter)) on.delete(filter);
  else on.add(filter);
  return QUESTION_FILTERS.filter((entry) => on.has(entry));
}
