import type {
  EnvironmentId,
  ThreadId,
  WaitingCounts,
  WaitingItemSummary,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import {
  useWaitingCardsEnabled,
  useThreadQuestionsWorkspace,
} from "../../../state/thread-questions";
import { questionRefreshKey } from "./questionCard.logic";
import {
  removeQuestionRecordsFromComposer,
  syncQuestionRecordsInComposer,
} from "./questionComposer";
import { useFocusedQuestionsRefresh } from "./useFocusedQuestionsRefresh";

/**
 * The thread's question upkeep, with nothing on screen: it keeps the thread's questions fresh
 * and keeps the composer's answer and comment chips in step with them.
 */
export function ThreadQuestionsSync(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly latestRun: { readonly runId: string; readonly completedAt: string | null } | null;
  readonly waiting: ReadonlyArray<WaitingItemSummary> | undefined;
  readonly waitingCounts: WaitingCounts | undefined;
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const { workspace, refresh } = useThreadQuestionsWorkspace(threadRef);
  const enabled = useWaitingCardsEnabled(threadRef.environmentId);
  const refreshKey = questionRefreshKey(props.latestRun, props.waiting, props.waitingCounts);
  const seenKey = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the thread's questions from the server when its latest run, question counts or question rows change, the shell's signal that a question changed on any client
  useEffect(() => {
    // The query fetches on mount, so only a later change refetches.
    if (seenKey.current !== null && seenKey.current !== refreshKey) refresh();
    seenKey.current = refreshKey;
  }, [refresh, refreshKey]);
  useFocusedQuestionsRefresh(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the composer's question chips live in the persisted draft store, so they follow server-side question changes: a closed or sent question drops its chip and a newer draft updates it
  useEffect(() => {
    if (workspace != null) syncQuestionRecordsInComposer(threadRef, workspace);
  }, [threadRef, workspace]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- question chips persist in the draft store across a settings change; turning waiting cards off takes them out so they never send
  useEffect(() => {
    if (enabled === false) removeQuestionRecordsFromComposer(threadRef);
  }, [threadRef, enabled]);
  return null;
}
