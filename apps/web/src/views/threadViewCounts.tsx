import { useAtomValue } from "@effect/atom-react";
import { useOpenFollowUpCount } from "../components/reviews/FollowUps";
import { useThreadShell } from "../state/entities";
import { waitingCardsEnvironmentIdsAtom } from "../state/threadQuestions";
import { useThreadToolSignals } from "../components/ThreadToolsAttention";
import { ViewCount, type ViewCountProps } from "./ViewCount";

/** The agent's open checklist items and your open follow-up flags. */
export function ChecklistCount({ target, mark }: ViewCountProps) {
  const { listCount } = useThreadToolSignals(target.threadRef);
  const shell = useThreadShell(target.threadRef);
  const cards = useAtomValue(waitingCardsEnvironmentIdsAtom);
  const tracked =
    target.threadRef && cards.includes(target.threadRef.environmentId)
      ? (shell?.waitingCounts?.owed ?? 0) + (shell?.waitingCounts?.answer ?? 0)
      : 0;
  const count = listCount + useOpenFollowUpCount(target.threadRef) + tracked;
  return count === 0 ? null : <ViewCount mark={mark}>{count}</ViewCount>;
}

/** Questions agents asked in this thread's artifacts that still wait for an answer. */
export function ArtifactsCount({ target, mark }: ViewCountProps) {
  const { questionCount } = useThreadToolSignals(target.threadRef);
  return questionCount === 0 ? null : <ViewCount mark={mark}>{questionCount}</ViewCount>;
}

/** Marks Links when the thread's ticket needs review. */
export function LinksCount({ target, mark }: ViewCountProps) {
  const { ticketState } = useThreadToolSignals(target.threadRef);
  return ticketState === "needs_review" ? <ViewCount mark={mark}>Needs review</ViewCount> : null;
}
