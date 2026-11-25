import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { type ComponentProps, useLayoutEffect } from "react";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useTimelineVisibleTurnItems } from "../../state/entities";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import { withQuestionDismissals } from "../questions/questionDismissals.logic";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * reasoning delta re-renders the timeline without re-rendering ChatView. Streamed
 * assistant text reaches only its own row, through useAssistantMessageText.
 */
export function ThreadTimeline({
  threadDetailRef,
  entriesInput,
  inlineArchiveRunIds,
  draftEntries,
  questionDismissals,
  historyComplete,
  activeThreadKey,
  syncing,
  detailLoading,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** Inherited runs shown inline, where the parent already displays the shared prefix. */
  inlineArchiveRunIds?: ReadonlySet<RunId> | undefined;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  /** The user's question dismissals, placed in the timeline where they happened. */
  questionDismissals: Parameters<typeof withQuestionDismissals>[1];
  /** No older history is left to load, so a dismissal before the first row may show. */
  historyComplete: boolean;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
}) {
  const visibleTurnItems = useTimelineVisibleTurnItems(threadDetailRef);
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems:
      inlineArchiveRunIds === undefined
        ? visibleTurnItems
        : visibleTurnItems.filter(
            (row) =>
              row.visibility !== "inherited" ||
              (row.item.runId !== null && inlineArchiveRunIds.has(row.item.runId)),
          ),
  });
  const entries =
    draftEntries ?? withQuestionDismissals(serverEntries, questionDismissals, historyComplete);
  // The standalone archive needs the complete timeline when it opens from the inline pane.
  const cacheKey = inlineArchiveRunIds === undefined ? activeThreadKey : null;
  const displayedEntries = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey: cacheKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(cacheKey),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stores the committed ready timeline in the module-level cache used during thread switches
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({ threadKey: cacheKey, entries });
  }, [cacheKey, detailLoading, entries]);
  return <MessagesTimeline {...timelineProps} timelineEntries={displayedEntries} />;
}
