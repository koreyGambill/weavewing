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
 * open or deferred and keeps its full card.
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
      return "Dismissed";
    case "replaced":
      return question.replacedBy === null ? "Replaced" : `Replaced by ${question.replacedBy}`;
  }
}
