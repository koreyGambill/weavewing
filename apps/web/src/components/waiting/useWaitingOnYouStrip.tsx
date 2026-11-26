import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadQuestionHasDraft } from "@t3tools/client-runtime/state/thread-questions";
import type {
  EnvironmentId,
  ScopedThreadRef,
  WaitingCounts,
  WaitingItemSummary,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerArtifactAnswers } from "../../composerDraftStore";
import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import { useRightPanelStore } from "../../rightPanelStore";
import { serverEnvironment } from "../../state/server";
import { useSaveQuestionDraft, useThreadQuestionsWorkspace } from "../../state/threadQuestions";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import {
  addDraftedAnswersToComposer,
  removeQuestionRecordsFromComposer,
  syncQuestionAnswersInComposer,
  useQuestionsInComposer,
} from "../questions/questionComposer";
import { questionDraftWriter } from "../questions/questionDraftWriter";
import { reconcileQuestionNoteImages } from "../questions/questionNoteImages";
import { Button } from "../ui/button";
import { WaitingItemsList, WAITING_KIND_ICON } from "./WaitingItemsList";
import { WAITING_KIND_LABEL, groupWaitingItems, waitingStripSummary } from "./waitingStrip.logic";

/**
 * The one strip above the composer for what waits on the user: questions, landed changes to
 * check and tasks. Collapsed it counts each kind; expanded it lists them with each kind's
 * one-click answer. It owns the thread's question refresh, since the waiting items or the latest
 * run moving is when questions change, and keeps the composer's answers in step with them.
 */
export function useWaitingOnYouStrip(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** The chat's environment, whose waiting-cards setting governs the composer's chips. */
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly waiting: ReadonlyArray<WaitingItemSummary> | undefined;
  readonly waitingCounts: WaitingCounts | undefined;
  readonly refreshKey: string;
  readonly focusComposer: () => void;
}): ComposerBannerStackItem | null {
  const { threadRef, enabled } = input;
  const { workspace, refresh } = useThreadQuestionsWorkspace(threadRef, enabled);
  const threadKey = threadRef === null ? "" : scopedThreadKey(threadRef);
  const [openForThread, setOpenForThread] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const saveDraft = useSaveQuestionDraft(threadRef);
  const inComposer = useQuestionsInComposer(threadRef);
  const composerAnswers = useComposerArtifactAnswers(threadRef);
  useWorkspaceMutationRefresh({
    enabled: enabled && threadRef !== null,
    mutationId: input.refreshKey,
    refresh,
    resourceKey:
      threadRef === null ? "" : `${threadRef.environmentId}:${threadRef.threadId}:questions`,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the composer's answer chips and the cards' pasted images live in the persisted draft store, so they follow server-side question changes and each other: a closed, sent or cleared question drops its chip, a newer draft updates it, and a question's notes, held images and chip images are kept in agreement
  useEffect(() => {
    if (threadRef === null || workspace == null) return;
    syncQuestionAnswersInComposer(threadRef, workspace);
    reconcileQuestionNoteImages({
      threadRef,
      questions: workspace.questions,
      chips: composerAnswers,
      writer: questionDraftWriter(scopedThreadKey(threadRef)),
      saveDraft,
    });
  }, [threadRef, workspace, composerAnswers, saveDraft]);
  // Null while settings load, so only a setting known to be off clears the chips.
  const cardsEnabled = useAtomValue(
    serverEnvironment.settingsValueAtom(input.environmentId),
  )?.waitingCardsEnabled;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- question chips persist in the draft store across a settings change; turning waiting cards off takes them out so they never send
  useEffect(() => {
    if (threadRef !== null && cardsEnabled === false) removeQuestionRecordsFromComposer(threadRef);
  }, [threadRef, cardsEnabled]);
  if (threadRef === null || !enabled) return null;
  const summary = waitingStripSummary(input.waiting, input.waitingCounts);
  if (summary === null) return null;
  const open = openForThread === threadKey;
  const close = () => {
    setOpenForThread(null);
    input.focusComposer();
  };
  const toAdd =
    workspace?.questions.filter(
      (question) => threadQuestionHasDraft(question) && !inComposer.has(question.id),
    ).length ?? 0;
  const addDrafted = async () => {
    setAdding(true);
    await addDraftedAnswersToComposer({
      threadRef,
      workspace: workspace ?? null,
      writer: questionDraftWriter(threadKey),
      saveDraft,
    });
    setAdding(false);
  };
  const hasQuestions = (input.waiting ?? []).some((item) => item.kind === "question");
  const spoken = [
    ...summary.counts.map(
      ({ kind, count }) =>
        `${count} ${count === 1 ? WAITING_KIND_LABEL[kind].one : WAITING_KIND_LABEL[kind].many}`,
    ),
    ...(summary.discussing > 0 ? [`${summary.discussing} discussing`] : []),
  ].join(", ");
  return {
    id: "thread-waiting",
    variant: "default",
    icon: <UserRoundIcon />,
    title: (
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} what is waiting on you: ${spoken}`}
        onClick={() => (open ? close() : setOpenForThread(threadKey))}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="shrink-0">Waiting on you</span>
        {summary.counts.map(({ kind, count }) => {
          const Icon = WAITING_KIND_ICON[kind];
          return (
            <span
              key={kind}
              className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground tabular-nums"
            >
              <Icon aria-hidden className="size-3.5" />
              {count}
            </span>
          );
        })}
        {summary.discussing > 0 ? (
          <span className="truncate text-muted-foreground">· {summary.discussing} discussing</span>
        ) : null}
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronUpIcon className="size-3.5 shrink-0" />
        )}
      </button>
    ),
    ...(open
      ? {
          actions: (
            <>
              {toAdd > 0 ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={adding}
                  onClick={() => void addDrafted()}
                >
                  Answer all drafted
                </Button>
              ) : null}
              {hasQuestions ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    useRightPanelStore.getState().open(threadRef, "questions", "tile-2")
                  }
                >
                  Open panel
                </Button>
              ) : null}
            </>
          ),
          children: (
            <WaitingItemsList
              threadRef={threadRef}
              groups={groupWaitingItems(input.waiting)}
              workspace={workspace ?? null}
              onClose={close}
            />
          ),
        }
      : {}),
  };
}
