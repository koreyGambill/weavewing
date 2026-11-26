import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { outgoingT3MessageLabel } from "@t3tools/client-runtime/t3ToolSummary";
import { workEntryOutgoingMessage } from "@t3tools/client-runtime/work-log/presentation";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View, type AccessibilityActionEvent } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { ThreadMessageLink, useThreadCardTarget } from "./ThreadMessageLink";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** A message this thread sent another thread, or null when the row is other work. */
export function useOutgoingMessageCard(row: ThreadFeedActivity, environmentId: EnvironmentId) {
  const outgoing = workEntryOutgoingMessage(row.workEntry);
  const thread = outgoing?.threadId
    ? scopeThreadRef(
        outgoing.environmentId ? EnvironmentId.make(outgoing.environmentId) : environmentId,
        ThreadId.make(outgoing.threadId),
      )
    : null;
  const target = useThreadCardTarget(thread);
  const openThread = useOpenLinkedThread();
  if (outgoing === null) return null;
  const label = outgoingT3MessageLabel(
    outgoing,
    scopeThreadRef(environmentId, row.projectedItem.sourceThreadId),
    target.shell,
  );
  return {
    label,
    thread,
    target,
    accessibilityLabel: `${label} ${thread ? target.title : "Thread unavailable"}`,
    // Screen readers treat the row as one element, so the target link is an action on it.
    accessibilityProps:
      thread && target.reachable
        ? {
            accessibilityActions: [{ name: "openThread", label: `Open ${target.title}` }],
            onAccessibilityAction: (event: AccessibilityActionEvent) => {
              if (event.nativeEvent.actionName !== "openThread") return;
              openThread({
                environmentId: String(thread.environmentId),
                threadId: String(thread.threadId),
              });
            },
          }
        : undefined,
  };
}

export function OutgoingMessageLabel(props: {
  readonly card: NonNullable<ReturnType<typeof useOutgoingMessageCard>>;
  readonly themeAppearance: "light" | "dark";
}) {
  const { card } = props;
  return (
    // 44 pt tall so the target link has a full-size touch target.
    <View className="min-h-11 min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden">
      <Text numberOfLines={1} className="shrink-0 text-sm text-foreground-muted">
        {card.label}
      </Text>
      {card.thread ? (
        <ThreadMessageLink
          thread={card.thread}
          title={card.target.title}
          glyphSeed={card.target.shell?.glyphSeed}
          reachable={card.target.reachable}
          themeAppearance={props.themeAppearance}
        />
      ) : (
        <Text numberOfLines={1} className="min-w-0 shrink text-sm text-foreground-secondary">
          Thread unavailable
        </Text>
      )}
    </View>
  );
}
