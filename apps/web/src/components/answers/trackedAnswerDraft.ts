import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { OrchestrationMessageContext, TrackedAsk } from "@t3tools/contracts";
import { trackedAskContextForMessage } from "@t3tools/shared/composerContextReferences";

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
  readonly restore: (
    key: string,
    context: OrchestrationMessageContext | undefined,
    asks: ReadonlyArray<TrackedAsk>,
  ) => void;
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
      restore: (key, context, asks) =>
        set(({ drafts }) => {
          const track = context?.trackedAsk !== undefined;
          const discuss = asks
            .filter((ask) => context?.discussAnswers?.includes(ask.id))
            .map(({ id, question }) => ({ id, question }));
          const next = { ...drafts };
          if (track || discuss.length > 0) next[key] = { track, discuss };
          else delete next[key];
          return { drafts: next };
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
  return {
    ...(context ?? { version: 1, records: [] }),
    ...(draft.track
      ? {
          trackedAsk: trackedAskContextForMessage(text, context?.records ?? []),
        }
      : {}),
    ...(draft.discuss.length === 0 ? {} : { discussAnswers: draft.discuss.map((ask) => ask.id) }),
  };
}
