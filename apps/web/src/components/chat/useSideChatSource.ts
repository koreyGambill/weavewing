import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  assistantCitationNavigation,
  messageRevealNavigation,
} from "~/lib/assistantCitationNavigation";
import { useQuietThreadProjection } from "../../state/entities";

export function useSideChatSource(
  threadRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "lineage" | "forkedFrom"> | null,
  embedded: boolean,
) {
  const navigate = useNavigate();
  const parentId = thread?.lineage.sideChat ? thread.lineage.parentThreadId : null;
  const parentRef = parentId === null ? null : scopeThreadRef(threadRef.environmentId, parentId);
  const anchor = thread?.lineage.sideChatAnchor;
  const fork = thread?.forkedFrom;
  const runId = fork?.type === "run" && fork.threadId === parentId ? fork.runId : null;
  const parentProjection = useQuietThreadProjection(
    anchor === undefined && runId !== null ? parentRef : null,
  )?.projection;
  const sourceMessageId = parentProjection?.runs.find((run) => run.id === runId)?.userMessageId;
  if (!parentRef) return null;

  if (anchor) {
    return {
      label: "Jump to source",
      open: () => {
        const reveal = assistantCitationNavigation({ ...anchor, ...parentRef, version: 1 }, null);
        const state = { ...reveal.state, openInlineSideChat: threadRef.threadId };
        if (embedded) {
          void navigate({ to: ".", hash: reveal.hash, state, resetScroll: false });
        } else {
          void navigate({ ...reveal, state });
        }
      },
    };
  }

  if (sourceMessageId) {
    return {
      label: "Jump to source",
      open: () =>
        void navigate(
          messageRevealNavigation(parentRef.environmentId, parentRef.threadId, sourceMessageId),
        ),
    };
  }

  return embedded
    ? null
    : {
        label: "Open parent thread",
        open: () => void navigate({ to: "/$environmentId/$threadId", params: parentRef }),
      };
}
