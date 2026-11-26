import {
  syncComposerQuestionAnswers,
  withoutThreadQuestionRecords,
  threadQuestionsInComposer,
  withComposerQuestionAnswer,
  withoutComposerQuestionAnswer,
} from "@t3tools/client-runtime/state/thread-questions";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ArtifactAnswerContextRecord,
  type ScopedThreadRef,
  type ThreadWorkspace,
} from "@t3tools/contracts";

import {
  composerAttachmentCountWithQuestionChips,
  useComposerArtifactAnswers,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { toastManager } from "../ui/toast";
import { draftedAnswersForComposer } from "@t3tools/client-runtime/state/thread-question-composer";
import type { questionDraftWriter, SaveQuestionDraft } from "./questionDraftWriter";

const answersOf = (threadRef: ScopedThreadRef) =>
  useComposerDraftStore.getState().getComposerDraft(threadRef)?.artifactAnswers ?? [];

/** What this device's composer for the thread holds per question: an answer, or an older comment. */
export function useQuestionsInComposer(
  threadRef: ScopedThreadRef | null,
): ReadonlyMap<string, "answer" | "discuss"> {
  return threadQuestionsInComposer(useComposerArtifactAnswers(threadRef));
}

/**
 * Puts answers in the thread's composer, each replacing an earlier one for its question, with
 * the images their notes mark. Adds nothing and says why when those images would pass the
 * message's attachment limit, so no chip is staged without its images.
 */
export function addQuestionAnswersToComposer(
  threadRef: ScopedThreadRef,
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
): boolean {
  if (records.length === 0) return true;
  const next = records.reduce(withComposerQuestionAnswer, answersOf(threadRef));
  if (
    composerAttachmentCountWithQuestionChips(threadRef, next) > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  ) {
    toastManager.add({
      type: "error",
      title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      description: "Remove an attachment from your message, then try again.",
    });
    return false;
  }
  useComposerDraftStore.getState().setArtifactAnswers(threadRef, next);
  return true;
}

/** Takes a question's answer out of the composer; its draft stays on the question. */
export function removeQuestionAnswerFromComposer(threadRef: ScopedThreadRef, questionId: string) {
  const current = answersOf(threadRef);
  const next = withoutComposerQuestionAnswer(current, questionId);
  if (next.length !== current.length)
    useComposerDraftStore.getState().setArtifactAnswers(threadRef, next);
}

/** Brings the composer's answers in line with a snapshot of the thread's questions. */
export function syncQuestionAnswersInComposer(
  threadRef: ScopedThreadRef,
  workspace: Pick<ThreadWorkspace, "revision" | "questions">,
) {
  const next = syncComposerQuestionAnswers(threadRef.threadId, answersOf(threadRef), workspace);
  if (next !== null) useComposerDraftStore.getState().setArtifactAnswers(threadRef, next);
}

/** Takes every question answer and discussion out of the composer; other chips stay. */
export function removeQuestionRecordsFromComposer(threadRef: ScopedThreadRef) {
  const next = withoutThreadQuestionRecords(answersOf(threadRef));
  if (next !== null) useComposerDraftStore.getState().setArtifactAnswers(threadRef, next);
}

/**
 * Saves every waiting draft edit, then puts each drafted answer in the composer, except where
 * the composer holds a discussion of that question. Toasts the
 * outcome, and adds nothing when a save failed.
 */
export async function addDraftedAnswersToComposer(input: {
  readonly threadRef: ScopedThreadRef;
  readonly workspace: ThreadWorkspace | null;
  readonly writer: ReturnType<typeof questionDraftWriter>;
  readonly saveDraft: SaveQuestionDraft<ThreadWorkspace>;
}) {
  const drafted = draftedAnswersForComposer(
    input.threadRef.threadId,
    input.workspace,
    await input.writer.flushAll(input.saveDraft),
  );
  // A question the user is discussing in the composer stays a discussion, not an answer.
  const discussing = new Set(
    (
      useComposerDraftStore.getState().getComposerDraft(input.threadRef)?.waitingItems ?? []
    ).flatMap((record) => (record.itemKind === "question" ? [record.key] : [])),
  );
  const records = drafted?.filter((record) => !discussing.has(record.questionId)) ?? null;
  if (records === null) {
    toastManager.add({
      type: "error",
      title: "An answer did not save",
      description: "Nothing was added to the composer. Try again once the connection is back.",
    });
    return;
  }
  if (!addQuestionAnswersToComposer(input.threadRef, records)) return;
  if (records.length > 0)
    toastManager.add({
      type: "success",
      title: `${records.length} ${records.length === 1 ? "answer" : "answers"} in the composer`,
      description: "They go with your next message.",
    });
}
