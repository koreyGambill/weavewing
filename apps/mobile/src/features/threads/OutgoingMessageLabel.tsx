import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { outgoingT3MessageLabel } from "@t3tools/client-runtime/t3ToolSummary";
import { workEntryOutgoingMessage } from "@t3tools/client-runtime/work-log/presentation";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { ThreadMessageLink, useThreadCardTarget } from "./ThreadMessageLink";

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
  };
}

export function OutgoingMessageLabel(props: {
  readonly card: NonNullable<ReturnType<typeof useOutgoingMessageCard>>;
  readonly themeAppearance: "light" | "dark";
}) {
  const { card } = props;
  return (
    <View className="min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden">
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
