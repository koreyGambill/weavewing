import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  trackedQuestionLabel,
  type OrchestrationMessageContext,
  type TrackedAsk,
} from "@t3tools/contracts";

interface AnswerDraft {
  readonly track: boolean;
  readonly discuss: ReadonlyArray<Pick<TrackedAsk, "id" | "question">>;
}

const emptyDraft: AnswerDraft = { track: false, discuss: [] };

interface AnswerDraftStore {
  readonly drafts: Record<string, AnswerDraft>;
  readonly toggleTrack: (key: string) => void;
  readonly toggleDiscuss: (key: string, ask: Pick<TrackedAsk, "id" | "question">) => void;
  readonly clearSent: (key: string, sent: AnswerDraft) => void;
}

export const useTrackedAnswerDraftStore = create<AnswerDraftStore>()(
  persist(
    (set) => ({
      drafts: {},
      toggleTrack: (key) =>
        set(({ drafts }) => {
          const current = drafts[key] ?? emptyDraft;
          return { drafts: { ...drafts, [key]: { ...current, track: !current.track } } };
        }),
      toggleDiscuss: (key, ask) =>
        set(({ drafts }) => {
          const current = drafts[key] ?? emptyDraft;
          const other = current.discuss.filter((entry) => entry.id !== ask.id);
          const discuss =
            other.length < current.discuss.length ? other : [...other, ask].slice(0, 20);
          return { drafts: { ...drafts, [key]: { ...current, discuss } } };
        }),
      clearSent: (key, sent) =>
        set((state) => {
          if (state.drafts[key] !== sent) return state;
          const drafts = { ...state.drafts };
          delete drafts[key];
          return { drafts };
        }),
    }),
    { name: "t3-tracked-answer-drafts", partialize: ({ drafts }) => ({ drafts }) },
  ),
);

export function useTrackedAnswerDraft(key: string) {
  return useTrackedAnswerDraftStore((store) => store.drafts[key] ?? emptyDraft);
}

export function withTrackedAnswerDraft(
  context: OrchestrationMessageContext | undefined,
  text: string,
  draft: AnswerDraft | undefined,
): OrchestrationMessageContext | undefined {
  if (!draft || (!draft.track && draft.discuss.length === 0)) return context;
  const eligible = (context?.records ?? []).flatMap(
    (record): NonNullable<TrackedAsk["about"]>[] => {
      if (record.kind === "waiting-item" && "itemKind" in record)
        return [{ kind: record.itemKind, key: record.key, ref: record.ref }];
      if (
        record.kind === "artifact-answer" &&
        "artifactId" in record &&
        (record.artifactId === THREAD_QUESTIONS_ARTIFACT_ID ||
          record.artifactId === THREAD_QUESTION_COMMENTS_ARTIFACT_ID)
      )
        return [{ kind: "question", key: record.questionId, ref: record.questionId }];
      return [];
    },
  );
  const about = eligible.length === 1 ? eligible[0] : undefined;
  return {
    ...(context ?? { version: 1, records: [] }),
    ...(draft.track
      ? {
          trackedAsk: {
            question: trackedQuestionLabel(text, about),
            ...(about === undefined ? {} : { about }),
          },
        }
      : {}),
    ...(draft.discuss.length === 0 ? {} : { discussAnswers: draft.discuss.map((ask) => ask.id) }),
  };
}
