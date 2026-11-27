import type { OrchestrationMessageContext, TrackedAsk } from "@t3tools/contracts";
import {
  useComposerDraftStore,
  type ComposerThreadTarget,
  type TrackedAnswerDraft,
} from "../../composerDraftStore";

const emptyDraft: TrackedAnswerDraft = { track: false, discuss: [] };

export function useTrackedAnswerDraft(target: ComposerThreadTarget | null) {
  return useComposerDraftStore((store) =>
    target === null ? emptyDraft : (store.getComposerDraft(target)?.trackedAnswer ?? emptyDraft),
  );
}

export function toggleTrackAnswer(target: ComposerThreadTarget) {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(target)?.trackedAnswer ?? emptyDraft;
  store.setTrackedAnswer(target, { ...current, track: !current.track });
}

export function toggleAnswerDiscussion(
  target: ComposerThreadTarget,
  ask: Pick<TrackedAsk, "id" | "question">,
) {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(target)?.trackedAnswer ?? emptyDraft;
  const remaining = current.discuss.filter((entry) => entry.id !== ask.id);
  const discuss =
    remaining.length < current.discuss.length
      ? remaining
      : [...remaining, { id: ask.id, question: ask.question }].slice(0, 20);
  store.setTrackedAnswer(target, { ...current, discuss });
}

export function restoreTrackedAnswerDraft(
  target: ComposerThreadTarget,
  context: OrchestrationMessageContext | undefined,
  asks: ReadonlyArray<TrackedAsk>,
) {
  useComposerDraftStore.getState().setTrackedAnswer(target, {
    track: context?.trackedAsk !== undefined,
    discuss: (context?.discussAnswers ?? []).map((id) => ({
      id,
      question: asks.find((ask) => ask.id === id)?.question ?? `Answer ${id}`,
    })),
  });
}
