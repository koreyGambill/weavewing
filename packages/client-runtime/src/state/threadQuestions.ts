import type { ThreadQuestion } from "@t3tools/contracts";

export type ThreadQuestionSection = "waiting" | "deferred" | "closed";

export const THREAD_QUESTION_SECTIONS: ReadonlyArray<ThreadQuestionSection> = [
  "waiting",
  "deferred",
  "closed",
];

function threadQuestionSection(question: Pick<ThreadQuestion, "state">) {
  return question.state === "open"
    ? "waiting"
    : question.state === "deferred"
      ? "deferred"
      : "closed";
}

/** A saved, unsent answer: a choice or a note that a submit would send. */
export function threadQuestionHasDraft(question: Pick<ThreadQuestion, "state" | "answer">) {
  const answer = question.answer;
  return (
    (question.state === "open" || question.state === "deferred") &&
    answer !== null &&
    answer.submittedAt === null &&
    (answer.chosenOptionIds.length > 0 || answer.notes.trim() !== "")
  );
}

/** Waiting and deferred oldest first, as asked; closed newest first, so recent outcomes lead. */
export function sectionThreadQuestions<Q extends Pick<ThreadQuestion, "state" | "closedAt">>(
  questions: ReadonlyArray<Q>,
): Record<ThreadQuestionSection, Q[]> {
  const sections: Record<ThreadQuestionSection, Q[]> = { waiting: [], deferred: [], closed: [] };
  for (const question of questions) sections[threadQuestionSection(question)].push(question);
  sections.closed.reverse();
  sections.closed.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  return sections;
}

export function threadQuestionCounts(
  questions: ReadonlyArray<Pick<ThreadQuestion, "state" | "answer">>,
) {
  let waiting = 0;
  let deferred = 0;
  let drafted = 0;
  for (const question of questions) {
    if (question.state === "open") waiting++;
    else if (question.state === "deferred") deferred++;
    if (threadQuestionHasDraft(question)) drafted++;
  }
  return { waiting, deferred, drafted };
}

/** The chosen options, then the note, as one line; empty when nothing was chosen. */
export function threadQuestionAnswerText(
  question: Pick<ThreadQuestion, "options" | "answer">,
): string {
  const answer = question.answer;
  if (answer === null) return "";
  const choice = question.options
    .filter((option) => answer.chosenOptionIds.includes(option.id))
    .map((option) => option.label)
    .join(", ");
  const note = answer.notes.trim();
  return choice && note ? `${choice}: ${note}` : choice || note;
}
