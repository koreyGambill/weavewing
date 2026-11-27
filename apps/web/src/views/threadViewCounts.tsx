import { useOpenFollowUpCount } from "../components/reviews/FollowUps";
import { useThreadToolSignals } from "../components/ThreadToolsAttention";
import { MenuItemDetail } from "../components/ui/menu";
import type { ViewTarget } from "./viewRegistry";

/** The agent's open checklist items and your open follow-up flags. */
export function ChecklistCount({ target }: { readonly target: ViewTarget }) {
  const { listCount } = useThreadToolSignals(target.threadRef);
  const count = listCount + useOpenFollowUpCount(target.threadRef);
  return count === 0 ? null : <MenuItemDetail>{count}</MenuItemDetail>;
}

/** Questions agents asked in this thread's artifacts that still wait for an answer. */
export function ArtifactsCount({ target }: { readonly target: ViewTarget }) {
  const { questionCount } = useThreadToolSignals(target.threadRef);
  return questionCount === 0 ? null : <MenuItemDetail>{questionCount}</MenuItemDetail>;
}

/** Marks Links when the thread's ticket needs review. */
export function LinksCount({ target }: { readonly target: ViewTarget }) {
  const { ticketState } = useThreadToolSignals(target.threadRef);
  return ticketState === "needs_review" ? <MenuItemDetail>Needs review</MenuItemDetail> : null;
}
