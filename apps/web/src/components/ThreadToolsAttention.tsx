import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useInboxSignal } from "../state/inbox";
import { sidebarWorkspaceGet } from "../state/threadWorkspace";
import {
  summarizeThreadTools,
  threadToolsAttention,
  type ThreadToolsAttentionTone,
} from "../threadContextSidebar";
import { useSelectedThreadRef } from "./threadToolsHost";

/** The selected thread's counts from its workspace, which the attention dot keeps loaded. */
export function useThreadToolSignals(threadRef: ScopedThreadRef | null) {
  const canRead = useEnvironmentScope(threadRef?.environmentId ?? null, AuthOrchestrationReadScope);
  const workspace = useEnvironmentQuery(
    threadRef && canRead
      ? sidebarWorkspaceGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  return summarizeThreadTools(workspace.data ?? null);
}

const attentionToneClass: Record<ThreadToolsAttentionTone, string> = {
  alert: "bg-destructive",
  question: "bg-primary",
  warn: "bg-warning",
  review: "bg-info",
  todo: "bg-muted-foreground",
};

/** What needs the user in the selected thread and the inbox, for the hidden sidebar's toggle. */
export function useThreadToolsAttention() {
  const signals = useThreadToolSignals(useSelectedThreadRef());
  const inbox = useInboxSignal();
  return threadToolsAttention(signals, inbox);
}

export function ThreadToolsAttentionDot({ tone }: { tone: ThreadToolsAttentionTone }) {
  return (
    <span
      aria-hidden
      data-attention={tone}
      className={cn(
        "pointer-events-none absolute left-[calc(var(--workspace-titlebar-control-size)-0.375rem)] top-[calc(50%-var(--workspace-titlebar-control-size)/2)] size-2 rounded-full ring-2 ring-background",
        attentionToneClass[tone],
      )}
    />
  );
}
