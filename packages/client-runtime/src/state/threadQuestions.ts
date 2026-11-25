import {
  THREAD_QUESTIONS_ARTIFACT_ID,
  threadQuestionTitle,
  type ArtifactAnswerContextRecord,
  type ThreadQuestion,
} from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";

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

type DraftFields = Pick<ThreadQuestion, "state" | "answer" | "sentInMessageId">;

/** A user message carries the answer and its turn has not started. */
function threadQuestionIsSent(question: DraftFields): boolean {
  return (
    (question.state === "open" || question.state === "deferred") &&
    question.sentInMessageId !== undefined
  );
}

/** A saved answer nothing has carried yet: a choice or a note. */
export function threadQuestionHasDraft(question: DraftFields) {
  const answer = question.answer;
  return (
    (question.state === "open" || question.state === "deferred") &&
    question.sentInMessageId === undefined &&
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

/** Sent answers no longer wait on the user, so they leave `waiting` and `deferred`. */
export function threadQuestionCounts(questions: ReadonlyArray<DraftFields>) {
  let waiting = 0;
  let deferred = 0;
  let drafted = 0;
  for (const question of questions) {
    if (threadQuestionIsSent(question)) continue;
    if (question.state === "open") waiting++;
    else if (question.state === "deferred") deferred++;
    if (threadQuestionHasDraft(question)) drafted++;
  }
  return { waiting, deferred, drafted };
}

export type ThreadQuestionStatus =
  | "open"
  | "deferred"
  | "drafted"
  | "in-composer"
  | "sent"
  | "received"
  | "recorded"
  | "dismissed"
  | "replaced";

/** Where a question's answer is; `inComposer` is whether this device's composer holds it. */
export function threadQuestionStatus(
  question: Pick<ThreadQuestion, "state" | "answer" | "answeredBy" | "sentInMessageId">,
  inComposer: boolean,
): ThreadQuestionStatus {
  switch (question.state) {
    case "answered":
      return question.answeredBy === "agent" ? "recorded" : "received";
    case "withdrawn":
      return "dismissed";
    case "replaced":
      return "replaced";
    case "open":
    case "deferred":
      if (threadQuestionIsSent(question)) return "sent";
      if (!threadQuestionHasDraft(question)) return question.state;
      return inComposer ? "in-composer" : "drafted";
  }
}

const isQuestionAnswer = (record: ArtifactAnswerContextRecord) =>
  record.artifactId === THREAD_QUESTIONS_ARTIFACT_ID;

/** The ids of the questions whose answers ride in a composer's answer records. */
export function threadQuestionIdsInComposer(
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
): ReadonlySet<string> {
  return new Set(records.filter(isQuestionAnswer).map((record) => record.questionId));
}

/**
 * The composer record that carries a question's draft, or null without a draft. Its context id
 * is fixed per question, so a changed draft replaces the chip instead of adding another.
 */
export function threadQuestionAnswerRecord(
  threadId: string,
  question: Pick<
    ThreadQuestion,
    "id" | "prompt" | "options" | "state" | "answer" | "sentInMessageId"
  >,
): ArtifactAnswerContextRecord | null {
  const answer = question.answer;
  if (answer === null || !threadQuestionHasDraft(question)) return null;
  const title = `${question.id}: ${threadQuestionTitle(question.prompt)}`;
  return {
    version: 1,
    kind: "artifact-answer",
    contextId: toComposerContextId(`answer_${threadId}:${question.id}`),
    label: sanitizeComposerContextLabel(title, "artifact-answer"),
    artifactId: THREAD_QUESTIONS_ARTIFACT_ID,
    questionId: question.id,
    answerRevision: answer.draftRevision ?? 0,
    title: title.slice(0, 200),
    artifactVersion: 1,
    question: question.prompt,
    choice: question.options
      .filter((option) => answer.chosenOptionIds.includes(option.id))
      .map((option) => option.label)
      .join(", "),
    note: answer.notes,
  };
}

/**
 * A composer's answer records brought up to date with the thread's questions: each question
 * answer follows its draft, and one whose question closed, was sent, or lost its draft is
 * dropped. Returns null when nothing changed.
 */
export function syncComposerQuestionAnswers(
  threadId: string,
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
  questions: ReadonlyArray<ThreadQuestion>,
): ArtifactAnswerContextRecord[] | null {
  let changed = false;
  const next = records.flatMap((record) => {
    if (!isQuestionAnswer(record)) return [record];
    const question = questions.find((entry) => entry.id === record.questionId);
    const fresh = question === undefined ? null : threadQuestionAnswerRecord(threadId, question);
    if (fresh === null) {
      changed = true;
      return [];
    }
    if (
      fresh.answerRevision !== record.answerRevision ||
      fresh.choice !== record.choice ||
      fresh.note !== record.note ||
      fresh.label !== record.label ||
      fresh.contextId !== record.contextId
    ) {
      changed = true;
      return [fresh];
    }
    return [record];
  });
  return changed ? next : null;
}

/** `records` with `record` added, or replacing the answer to the same question. */
export function withComposerQuestionAnswer(
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
  record: ArtifactAnswerContextRecord,
): ArtifactAnswerContextRecord[] {
  const index = records.findIndex(
    (entry) => isQuestionAnswer(entry) && entry.questionId === record.questionId,
  );
  if (index < 0) return [...records, record];
  return records.map((entry, position) => (position === index ? record : entry));
}

export function withoutComposerQuestionAnswer(
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
  questionId: string,
): ArtifactAnswerContextRecord[] {
  return records.filter((entry) => !(isQuestionAnswer(entry) && entry.questionId === questionId));
}
