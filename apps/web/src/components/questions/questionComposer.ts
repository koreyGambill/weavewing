import {
  syncComposerQuestionAnswers,
  threadQuestionIdsInComposer,
  withComposerQuestionAnswer,
  withoutComposerQuestionAnswer,
} from "@t3tools/client-runtime/state/thread-questions";
import type {
  ArtifactAnswerContextRecord,
  ScopedThreadRef,
  ThreadQuestion,
  ThreadWorkspace,
} from "@t3tools/contracts";

import { useComposerArtifactAnswers, useComposerDraftStore } from "../../composerDraftStore";
import { toastManager } from "../ui/toast";
import { draftedAnswersForComposer } from "./questionComposer.logic";
import type { questionDraftWriter, SaveQuestionDraft } from "./questionDraftWriter";

const answersOf = (threadRef: ScopedThreadRef) =>
  useComposerDraftStore.getState().getComposerDraft(threadRef)?.artifactAnswers ?? [];

/** The questions whose answers this device's composer for the thread holds. */
export function useQuestionIdsInComposer(threadRef: ScopedThreadRef | null): ReadonlySet<string> {
  return threadQuestionIdsInComposer(useComposerArtifactAnswers(threadRef));
}

/** Puts answers in the thread's composer, each replacing an earlier one for its question. */
export function addQuestionAnswersToComposer(
  threadRef: ScopedThreadRef,
  records: ReadonlyArray<ArtifactAnswerContextRecord>,
) {
  if (records.length === 0) return;
  useComposerDraftStore
    .getState()
    .setArtifactAnswers(
      threadRef,
      records.reduce(withComposerQuestionAnswer, answersOf(threadRef)),
    );
}

/** Takes a question's answer out of the composer; its draft stays on the question. */
export function removeQuestionAnswerFromComposer(threadRef: ScopedThreadRef, questionId: string) {
  const current = answersOf(threadRef);
  const next = withoutComposerQuestionAnswer(current, questionId);
  if (next.length !== current.length)
    useComposerDraftStore.getState().setArtifactAnswers(threadRef, next);
}

/** Brings the composer's answers in line with the thread's questions after they change. */
export function syncQuestionAnswersInComposer(
  threadRef: ScopedThreadRef,
  questions: ReadonlyArray<ThreadQuestion>,
) {
  const next = syncComposerQuestionAnswers(threadRef.threadId, answersOf(threadRef), questions);
  if (next !== null) useComposerDraftStore.getState().setArtifactAnswers(threadRef, next);
}

/**
 * Saves every waiting draft edit, then puts each drafted answer in the composer. Toasts the
 * outcome, and adds nothing when a save failed.
 */
export async function addDraftedAnswersToComposer(input: {
  readonly threadRef: ScopedThreadRef;
  readonly workspace: ThreadWorkspace | null;
  readonly writer: ReturnType<typeof questionDraftWriter>;
  readonly saveDraft: SaveQuestionDraft<ThreadWorkspace>;
}) {
  const records = draftedAnswersForComposer(
    input.threadRef.threadId,
    input.workspace,
    await input.writer.flushAll(input.saveDraft),
  );
  if (records === null) {
    toastManager.add({
      type: "error",
      title: "An answer did not save",
      description: "Nothing was added to the composer. Try again once the connection is back.",
    });
    return;
  }
  addQuestionAnswersToComposer(input.threadRef, records);
  if (records.length > 0)
    toastManager.add({
      type: "success",
      title: `${records.length} ${records.length === 1 ? "answer" : "answers"} in the composer`,
      description: "They go with your next message.",
    });
}
