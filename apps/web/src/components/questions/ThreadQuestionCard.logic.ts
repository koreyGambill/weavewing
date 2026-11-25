import type { ThreadQuestion } from "@t3tools/contracts";

/** The answer a question carries as one line: chosen labels, then the note. Empty for none. */
function questionAnswerLine(question: Pick<ThreadQuestion, "options" | "answer">): string {
  const answer = question.answer;
  if (answer === null) return "";
  const choice = question.options
    .filter((option) => answer.chosenOptionIds.includes(option.id))
    .map((option) => option.label)
    .join(", ");
  const note = answer.notes.trim();
  return [choice, note ? `“${note}”` : ""].filter(Boolean).join(" · ");
}

/**
 * What a closed question's one line shows after its prompt, or null while the question is still
 * open or deferred and keeps its full card. Empty when the status badge already says it.
 */
export function closedQuestionOutcome(
  question: Pick<ThreadQuestion, "state" | "options" | "answer" | "replacedBy">,
): string | null {
  switch (question.state) {
    case "open":
    case "deferred":
      return null;
    case "answered":
      return questionAnswerLine(question) || "Answered";
    case "withdrawn":
      // The status badge already says Dismissed.
      return "";
    case "replaced":
      return question.replacedBy === null ? "Replaced" : `Replaced by ${question.replacedBy}`;
  }
}

/**
 * The choice and note an expanded closed card shows. Only an answer is shown: a dismissed or
 * replaced question may still hold a draft, which would read as if it had been answered.
 */
export function closedQuestionShownAnswer(question: Pick<ThreadQuestion, "state" | "answer">): {
  readonly chosenOptionIds: ReadonlyArray<string>;
  readonly notes: string;
} {
  const answer = question.state === "answered" ? question.answer : null;
  return { chosenOptionIds: answer?.chosenOptionIds ?? [], notes: answer?.notes.trim() ?? "" };
}
