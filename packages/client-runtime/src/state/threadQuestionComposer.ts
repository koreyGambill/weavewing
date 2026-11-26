import { threadQuestionAnswerRecord, threadQuestionHasDraft } from "./threadQuestions.ts";
import type { ThreadQuestion, ThreadWorkspace } from "@t3tools/contracts";

/**
 * The answer record to put in the composer for `shown` once its draft writes settled: from the
 * draft the newest save returned, else the rendered one. Null when that save failed, so nothing
 * the server never stored is queued, or when there is nothing to send.
 */
export function questionAnswerForComposer(
  threadId: string,
  shown: ThreadQuestion,
  flushed: { readonly saved: ThreadWorkspace | null } | null,
) {
  if (flushed === null) return null;
  const latest = flushed.saved?.questions.find((question) => question.id === shown.id) ?? shown;
  return threadQuestionAnswerRecord(threadId, latest);
}

/**
 * Every drafted answer to put in the composer once all draft writes settled, from whichever
 * workspace is newer. Null when a save failed, so nothing unsaved is queued.
 */
export function draftedAnswersForComposer(
  threadId: string,
  shown: ThreadWorkspace | null,
  flushed: { readonly saved: ThreadWorkspace | null } | null,
) {
  if (flushed === null) return null;
  const saved = flushed.saved;
  const latest = saved !== null && saved.revision > (shown?.revision ?? -1) ? saved : shown;
  return (latest?.questions ?? []).filter(threadQuestionHasDraft).flatMap((question) => {
    const record = threadQuestionAnswerRecord(threadId, question);
    return record === null ? [] : [record];
  });
}
