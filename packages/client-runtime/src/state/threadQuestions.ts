import {
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  THREAD_QUESTIONS_REFRESH_REQUEST,
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
  | "comment-in-composer"
  | "sent"
  | "discussing"
  | "received"
  | "recorded"
  | "dismissed"
  | "replaced";

/**
 * Where a question's answer or discussion is; `inComposer` is what this device's composer holds
 * for it: its answer, or a Discuss reference (an older draft may hold a comment instead). A sent
 * discussion outranks the draft, so a chosen option still reads as discussing.
 */
export function threadQuestionStatus(
  question: Pick<
    ThreadQuestion,
    "state" | "answer" | "answeredBy" | "sentInMessageId" | "discussedInMessageId"
  >,
  inComposer: "answer" | "discuss" | undefined,
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
      if (inComposer === "discuss") return "comment-in-composer";
      if (inComposer === "answer" && threadQuestionHasDraft(question)) return "in-composer";
      if (question.discussedInMessageId !== undefined) return "discussing";
      return threadQuestionHasDraft(question) ? "drafted" : question.state;
  }
}

/** A composer prompt with the questions refresh request after its text, unless it already has it. */
export function withQuestionsRefreshRequest(prompt: string): string {
  if (prompt.includes(THREAD_QUESTIONS_REFRESH_REQUEST)) return prompt;
  return prompt.trim()
    ? `${prompt.trimEnd()}\n\n${THREAD_QUESTIONS_REFRESH_REQUEST}`
    : THREAD_QUESTIONS_REFRESH_REQUEST;
}

/** The question `id` replaced, or null when it replaced none. */
export function threadQuestionReplaced(
  questions: ReadonlyArray<Pick<ThreadQuestion, "id" | "replacedBy">>,
  id: string,
): string | null {
  return questions.find((question) => question.replacedBy === id)?.id ?? null;
}

const isQuestionAnswer = (record: ArtifactAnswerContextRecord) =>
  record.artifactId === THREAD_QUESTIONS_ARTIFACT_ID;
const isQuestionComment = (record: ArtifactAnswerContextRecord) =>
  record.artifactId === THREAD_QUESTION_COMMENTS_ARTIFACT_ID;
/** A composer record that answers or discusses an agent question, not another artifact's answer. */
export const isThreadQuestionRecord = (record: ArtifactAnswerContextRecord) =>
  isQuestionAnswer(record) || isQuestionComment(record);
const isQuestionRecord = isThreadQuestionRecord;

/** What a composer holds for each question: its answer, or a comment to discuss it. */
export function threadQuestionsInComposer(
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
): ReadonlyMap<string, "answer" | "discuss"> {
  return new Map(
    records
      .filter(isQuestionRecord)
      .map((record) => [record.questionId, isQuestionAnswer(record) ? "answer" : "discuss"]),
  );
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
 * The composer record that discusses a question without answering it: the note alone, so a
 * chosen option stays a draft. Null without a note, or once the question no longer waits.
 */
export function threadQuestionDiscussRecord(
  threadId: string,
  question: Pick<ThreadQuestion, "id" | "prompt" | "state" | "answer" | "sentInMessageId">,
): ArtifactAnswerContextRecord | null {
  const note = question.answer?.notes.trim() ?? "";
  if (
    note === "" ||
    (question.state !== "open" && question.state !== "deferred") ||
    question.sentInMessageId !== undefined
  )
    return null;
  const title = `${question.id} · discuss: ${threadQuestionTitle(question.prompt)}`;
  return {
    version: 1,
    kind: "artifact-answer",
    contextId: toComposerContextId(`comment_${threadId}:${question.id}`),
    label: sanitizeComposerContextLabel(title, "artifact-answer"),
    artifactId: THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
    questionId: question.id,
    answerRevision: question.answer?.draftRevision ?? 0,
    title: title.slice(0, 200),
    artifactVersion: 1,
    question: question.prompt,
    choice: "",
    note,
  };
}

/**
 * A composer's question records brought up to date with a workspace snapshot at least as new as
 * each chip's draft: an answer follows a newer draft and a discussion a newer note, and one whose
 * question closed, was sent, or lost what it carries is dropped. An older snapshot changes
 * nothing. Returns null when nothing changed.
 */
export function syncComposerQuestionAnswers(
  threadId: string,
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
  workspace: { readonly revision: number; readonly questions: ReadonlyArray<ThreadQuestion> },
): ArtifactAnswerContextRecord[] | null {
  let changed = false;
  const next = records.flatMap((record) => {
    if (!isQuestionRecord(record)) return [record];
    const question = workspace.questions.find((entry) => entry.id === record.questionId);
    // Another tile can hold an older snapshot: one older than the chip's draft changes nothing.
    if (question === undefined || workspace.revision < record.answerRevision) return [record];
    // Null once the question is closed or sent, or its draft no longer carries anything.
    const fresh = isQuestionAnswer(record)
      ? threadQuestionAnswerRecord(threadId, question)
      : threadQuestionDiscussRecord(threadId, question);
    if (fresh === null) {
      changed = true;
      return [];
    }
    if (fresh.answerRevision <= record.answerRevision) return [record];
    changed = true;
    return [fresh];
  });
  return changed ? next : null;
}

/**
 * `records` with `record` added, replacing whatever the composer held for the same question, so
 * a question has an answer or a discussion there, never both.
 */
export function withComposerQuestionAnswer(
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
  record: ArtifactAnswerContextRecord,
): ArtifactAnswerContextRecord[] {
  const index = records.findIndex(
    (entry) => isQuestionRecord(entry) && entry.questionId === record.questionId,
  );
  if (index < 0) return [...records, record];
  return records.map((entry, position) => (position === index ? record : entry));
}

export function withoutComposerQuestionAnswer(
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
  questionId: string,
): ArtifactAnswerContextRecord[] {
  return records.filter((entry) => !(isQuestionRecord(entry) && entry.questionId === questionId));
}

const CHIP_ANSWER_MAX = 60;

/**
 * A question record's chip as one line: id, short title and the chosen answer or the start of the
 * note, or, for a discussion, id and the start of the note. Null for any other record.
 */
export function threadQuestionChipText(record: ArtifactAnswerContextRecord): string | null {
  if (!isQuestionRecord(record)) return null;
  const cut = (text: string) =>
    text.length > CHIP_ANSWER_MAX ? `${text.slice(0, CHIP_ANSWER_MAX)}…` : text;
  const note = record.note.replace(/\s+/g, " ").trim();
  if (isQuestionComment(record)) return `${record.questionId} · discuss · ${cut(note)}`;
  const answer = record.choice || note;
  const title = threadQuestionTitle(record.question);
  return answer
    ? `${record.questionId} · ${title} · ${cut(answer)}`
    : `${record.questionId} · ${title}`;
}

/** `records` without question answers or discussions, or null when it holds none. */
export function withoutThreadQuestionRecords(
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
): ArtifactAnswerContextRecord[] | null {
  const next = records.filter((record) => !isQuestionRecord(record));
  return next.length === records.length ? null : next;
}

/** What a question's note says where its `number`th pasted image belongs, such as `[Q1 image 1]`. */
export function threadQuestionImageMarker(questionId: string, number: number): string {
  return `[${questionId} image ${number}]`;
}

/**
 * The file name a question's pasted image travels under, such as `Q1-image-1.png`. Providers name
 * each attachment to the model, so the name pairs the image with the marker in the note.
 */
export function threadQuestionImageName(
  questionId: string,
  number: number,
  extension: string,
): string {
  return `${questionId}-image-${number}.${extension}`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The number of `questionId`'s image called `name`, or null for any other file. */
export function threadQuestionImageNumber(questionId: string, name: string): number | null {
  const match = new RegExp(`^${escapeRegExp(questionId)}-image-(\\d+)\\.[^.]+$`).exec(name);
  return match ? Number(match[1]) : null;
}

// One rule for reading and deleting markers, so an edited spelling such as `[Q1 image 01]` that
// counts as image 1 is also what deleting image 1 removes.
const markerPattern = (questionId: string) =>
  new RegExp(`( ?)\\[${escapeRegExp(questionId)} image (\\d+)\\]`, "g");

/** The image numbers whose markers `note` still holds for `questionId`. */
export function threadQuestionImageMarkerNumbers(
  questionId: string,
  note: string,
): ReadonlySet<number> {
  return new Set([...note.matchAll(markerPattern(questionId))].map((match) => Number(match[2])));
}

/** `note` without any marker for `questionId`'s images in `numbers`, or the space beside it. */
export function withoutThreadQuestionImageMarkers(
  questionId: string,
  note: string,
  numbers: ReadonlySet<number>,
): string {
  let result = "";
  let cursor = 0;
  for (const match of note.matchAll(markerPattern(questionId))) {
    if (!numbers.has(Number(match[2]))) continue;
    // Take the space before the marker, or after it when the marker leads its line.
    let end = match.index + match[0].length;
    if (match[1] === "" && note[end] === " ") end += 1;
    result += note.slice(cursor, Math.max(cursor, match.index));
    cursor = Math.max(cursor, end);
  }
  return result + note.slice(cursor);
}

/**
 * The number for `questionId`'s next image: one past the highest held image or marker, so a
 * pasted image never takes the number of one the note still mentions.
 */
export function nextThreadQuestionImageNumber(
  questionId: string,
  heldNames: ReadonlyArray<string>,
  note: string,
): number {
  const used = [
    ...heldNames.flatMap((name) => threadQuestionImageNumber(questionId, name) ?? []),
    ...threadQuestionImageMarkerNumbers(questionId, note),
  ];
  return Math.max(0, ...used) + 1;
}

/** The ids of `questionId`'s held images whose markers `note` no longer holds. */
export function threadQuestionImagesWithoutMarkers(
  questionId: string,
  images: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  note: string,
): string[] {
  const marked = threadQuestionImageMarkerNumbers(questionId, note);
  return images
    .filter((image) => {
      const number = threadQuestionImageNumber(questionId, image.name);
      return number === null || !marked.has(number);
    })
    .map((image) => image.id);
}

/**
 * The markers to take out of a staged question's note: those its chip in the composer no longer
 * carries and whose image this device no longer holds, as after the image was removed from the
 * message. A marker the chip never carried, or whose image is still held, stays.
 */
export function threadQuestionMarkersDroppedByChip(
  questionId: string,
  note: string,
  chipNote: string,
  heldNames: ReadonlyArray<string>,
): ReadonlySet<number> {
  const onChip = threadQuestionImageMarkerNumbers(questionId, chipNote);
  const held = new Set(heldNames.map((name) => threadQuestionImageNumber(questionId, name)));
  return new Set(
    [...threadQuestionImageMarkerNumbers(questionId, note)].filter(
      (number) => !onChip.has(number) && !held.has(number),
    ),
  );
}
