import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ThreadWorkspace } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../../state/atom-registry";
import { threadQuestionDraft, type QuestionThreadRef } from "../../../state/thread-questions";
import { createQuestionDraftSavers } from "./questionCard.logic";

interface QuestionTarget {
  readonly threadRef: QuestionThreadRef;
  readonly questionId: string;
}

const savers = createQuestionDraftSavers<QuestionTarget, ThreadWorkspace>(
  ({ threadRef, questionId }) =>
    `${threadRef.environmentId}\u0000${threadRef.threadId}\u0000${questionId}`,
  ({ threadRef, questionId }) =>
    async (draft) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadQuestionDraft,
        {
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            answers: {
              [questionId]: { chosenOptionIds: [...draft.chosenOptionIds], notes: draft.notes },
            },
          },
        },
        { label: threadQuestionDraft.label, reportFailure: false },
      );
      return AsyncResult.isSuccess(result) ? result.value : null;
    },
);

/** The question's draft writes, shared by every card of it on any screen and across mounts. */
export function questionDraft(threadRef: QuestionThreadRef, questionId: string) {
  return savers.draft({ threadRef, questionId });
}

/** Counts a card showing the question; returns the release for unmount. */
export function holdQuestionDraft(threadRef: QuestionThreadRef, questionId: string) {
  return savers.hold({ threadRef, questionId });
}
