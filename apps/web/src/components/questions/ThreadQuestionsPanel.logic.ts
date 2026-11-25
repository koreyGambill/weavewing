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

/** J/K move, 1–9 choose an option, N defers, Escape closes the panel. */
export function questionPanelKeyAction(input: {
  readonly key: string;
  readonly order: ReadonlyArray<
    Pick<ThreadQuestion, "id" | "state" | "options" | "multiSelect" | "answer">
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
  const answerable = selected.state === "open" || selected.state === "deferred";
  if (lower === "n") return selected.state === "open" ? { type: "defer", id: selected.id } : null;
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
      : [option.id],
  };
}
