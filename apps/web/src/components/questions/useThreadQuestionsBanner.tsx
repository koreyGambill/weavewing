import type { ScopedThreadRef } from "@t3tools/contracts";
import { threadQuestionCounts } from "@t3tools/client-runtime/state/thread-questions";
import { MessageCircleQuestionIcon } from "lucide-react";

import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadQuestionsWorkspace } from "../../state/threadQuestions";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";

/**
 * The one-line strip above the composer while a thread has open or deferred questions. It owns
 * the thread's question refresh: the count or the latest run moving is when questions change.
 */
export function useThreadQuestionsBanner(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly enabled: boolean;
  readonly refreshKey: string;
}): ComposerBannerStackItem | null {
  const { threadRef, enabled } = input;
  const { workspace, refresh } = useThreadQuestionsWorkspace(threadRef, enabled);
  useWorkspaceMutationRefresh({
    enabled: enabled && threadRef !== null,
    mutationId: input.refreshKey,
    refresh,
    resourceKey:
      threadRef === null ? "" : `${threadRef.environmentId}:${threadRef.threadId}:questions`,
  });
  if (threadRef === null || workspace == null) return null;
  const counts = threadQuestionCounts(workspace.questions);
  if (counts.waiting + counts.deferred === 0) return null;
  const details = [
    counts.deferred > 0 ? `${counts.deferred} deferred` : null,
    counts.drafted > 0 ? `${counts.drafted} drafted` : null,
  ].filter(Boolean);
  return {
    id: "thread-questions",
    variant: "info",
    icon: <MessageCircleQuestionIcon />,
    title: (
      <span className="flex min-w-0 items-center gap-1.5">
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
      </span>
    ),
    actions: (
      <Button
        size="xs"
        variant="outline"
        onClick={() => useRightPanelStore.getState().open(threadRef, "questions", "tile-2")}
      >
        Review
      </Button>
    ),
  };
}
