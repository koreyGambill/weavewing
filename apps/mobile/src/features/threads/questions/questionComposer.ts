import {
  syncComposerQuestionAnswers,
  threadQuestionsInComposer,
  withComposerQuestionAnswer,
  withoutComposerQuestionAnswer,
  withoutThreadQuestionRecords,
} from "@t3tools/client-runtime/state/thread-questions";
import type { ArtifactAnswerContextRecord, ThreadWorkspace } from "@t3tools/contracts";

import { scopedThreadKey } from "../../../lib/scopedEntities";
import { updateComposerDraftContent, useComposerDraft } from "../../../state/use-composer-drafts";
import type { QuestionThreadRef } from "../../../state/thread-questions";
import { composerQuestionRecords, withComposerQuestionRecords } from "./questionComposerDraft";

const draftKeyOf = (threadRef: QuestionThreadRef) =>
  scopedThreadKey(threadRef.environmentId, threadRef.threadId);

function setQuestionRecords(
  threadRef: QuestionThreadRef,
  change: (
    records: ReadonlyArray<ArtifactAnswerContextRecord>,
  ) => ReadonlyArray<ArtifactAnswerContextRecord> | null,
) {
  updateComposerDraftContent(draftKeyOf(threadRef), (draft) => {
    const next = change(composerQuestionRecords(draft.context));
    return next === null ? null : withComposerQuestionRecords(draft, next);
  });
}

/** What the thread's composer holds per question: an answer or a discussion. */
export function useQuestionsInComposer(
  threadRef: QuestionThreadRef,
): ReadonlyMap<string, "answer" | "discuss"> {
  return threadQuestionsInComposer(
    composerQuestionRecords(useComposerDraft(draftKeyOf(threadRef)).context),
  );
}

/** Puts a question's answer or discussion in the composer, replacing what it held for it. */
export function addQuestionRecordToComposer(
  threadRef: QuestionThreadRef,
  record: ArtifactAnswerContextRecord,
) {
  setQuestionRecords(threadRef, (records) => withComposerQuestionAnswer(records, record));
}

/** Takes a question's answer or discussion out of the composer; its draft stays on the question. */
export function removeQuestionRecordFromComposer(threadRef: QuestionThreadRef, questionId: string) {
  setQuestionRecords(threadRef, (records) => withoutComposerQuestionAnswer(records, questionId));
}

/** Brings the composer's question records in line with a snapshot of the thread's questions. */
export function syncQuestionRecordsInComposer(
  threadRef: QuestionThreadRef,
  workspace: Pick<ThreadWorkspace, "revision" | "questions">,
) {
  setQuestionRecords(threadRef, (records) =>
    syncComposerQuestionAnswers(threadRef.threadId, records, workspace),
  );
}

/** Takes every question answer and discussion out of the composer; other context stays. */
export function removeQuestionRecordsFromComposer(threadRef: QuestionThreadRef) {
  setQuestionRecords(threadRef, (records) => withoutThreadQuestionRecords(records));
}
