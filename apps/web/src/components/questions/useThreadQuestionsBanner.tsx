import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  threadQuestionCounts,
  threadQuestionHasDraft,
} from "@t3tools/client-runtime/state/thread-questions";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtomValue } from "@effect/atom-react";

import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import { useComposerArtifactAnswers } from "../../composerDraftStore";
import { serverEnvironment } from "../../state/server";
import { useRightPanelStore } from "../../rightPanelStore";
import { useSaveQuestionDraft, useThreadQuestionsWorkspace } from "../../state/threadQuestions";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  addDraftedAnswersToComposer,
  removeQuestionRecordsFromComposer,
  syncQuestionAnswersInComposer,
  useQuestionsInComposer,
} from "./questionComposer";
import { questionDraftWriter } from "./questionDraftWriter";
import { reconcileQuestionNoteImages } from "./questionNoteImages";
import { ThreadQuestionsCompactList } from "./ThreadQuestionsCompactList";

/**
 * The strip above the composer while a thread has open or deferred questions; clicking it opens
 * a compact list of them. It owns the thread's question refresh, since the count or the latest
 * run moving is when questions change, and keeps the composer's answers in step with them.
 */
export function useThreadQuestionsBanner(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** The chat's environment, whose agent questions setting governs the composer's chips. */
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
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
  const questionsEnabled = useAtomValue(
    serverEnvironment.settingsValueAtom(input.environmentId),
  )?.agentQuestionsEnabled;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- question chips persist in the draft store across a settings change; turning agent questions off takes them out so they never send
  useEffect(() => {
    if (threadRef !== null && questionsEnabled === false)
      removeQuestionRecordsFromComposer(threadRef);
  }, [threadRef, questionsEnabled]);
  if (threadRef === null || workspace == null) return null;
  const counts = threadQuestionCounts(workspace.questions);
  if (counts.waiting + counts.deferred === 0) return null;
  const open = openForThread === threadKey;
  const close = () => {
    setOpenForThread(null);
    input.focusComposer();
  };
  const toAdd = workspace.questions.filter(
    (question) => threadQuestionHasDraft(question) && !inComposer.has(question.id),
  ).length;
  const addDrafted = async () => {
    setAdding(true);
    await addDraftedAnswersToComposer({
      threadRef,
      workspace,
      writer: questionDraftWriter(threadKey),
      saveDraft,
    });
    setAdding(false);
  };
  const details = [
    counts.deferred > 0 ? `${counts.deferred} deferred` : null,
    counts.drafted > 0 ? `${counts.drafted} drafted` : null,
  ].filter(Boolean);
  return {
    id: "thread-questions",
    variant: "info",
    icon: <MessageCircleQuestionIcon />,
    title: (
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide the questions list" : "Show the questions list"}
        onClick={() => (open ? close() : setOpenForThread(threadKey))}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {counts.waiting > 0 ? (
          <Badge variant="info" size="sm">
            {counts.waiting}
          </Badge>
        ) : null}
        <span className="truncate">
          {counts.waiting > 0
            ? `${counts.waiting === 1 ? "question" : "questions"} waiting`
            : "No questions waiting"}
          {details.length > 0 ? (
            <span className="text-muted-foreground"> · {details.join(" · ")}</span>
          ) : null}
        </span>
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronUpIcon className="size-3.5 shrink-0" />
        )}
      </button>
    ),
    actions: (
      <>
        {open ? (
          <Button
            size="xs"
            variant="outline"
            disabled={toAdd === 0 || adding}
            onClick={() => void addDrafted()}
          >
            Answer all drafted
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          onClick={() => useRightPanelStore.getState().open(threadRef, "questions", "tile-2")}
        >
          Open panel
        </Button>
      </>
    ),
    ...(open
      ? {
          children: (
            <ThreadQuestionsCompactList
              threadRef={threadRef}
              questions={workspace.questions}
              onClose={close}
            />
          ),
        }
      : {}),
  };
}
