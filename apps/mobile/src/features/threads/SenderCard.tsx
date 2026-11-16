import { MessageReactionChip } from "./MessageReactionChip";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { ScopedThreadRef, TurnOrigin } from "@t3tools/contracts";
import { senderCardDetails } from "@t3tools/client-runtime/user-message";
import { resolveThreadGlyph } from "@t3tools/client-runtime/thread-glyphs";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useEnvironmentServerConfig,
  useQuietThreadShell,
  useThreadTitle,
} from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function SenderCard(props: {
  readonly origin: Exclude<TurnOrigin, { kind: "user" }>;
  /** The thread that received the message; decides whether the sender is its child. */
  readonly threadRef: ScopedThreadRef | null;
  readonly text: string;
  readonly summary?: string | undefined;
  readonly createdAt?: string;
  readonly queued?: boolean;
  readonly reaction?:
    | import("@t3tools/client-runtime/state/message-reactions").InputMessageReaction
    | undefined;
  readonly children?: ReactNode;
}) {
  const sender = "threadId" in props.origin ? props.origin : null;
  const shell = useQuietThreadShell(sender);
  const liveTitle = useThreadTitle(sender)?.trim();
  const summariesOn =
    useEnvironmentServerConfig(props.threadRef?.environmentId ?? null)?.settings
      .incomingCardSummaries !== false;
  const details = senderCardDetails(
    props.origin,
    props.text,
    props.threadRef,
    shell,
    summariesOn ? props.summary : undefined,
  );
  const glyph = sender ? resolveThreadGlyph(sender.threadId, shell?.glyphSeed) : null;
  const { themeAppearance } = useAppearancePreferences();
  const color = glyph ? (themeAppearance === "dark" ? glyph.color : glyph.lightColor) : undefined;
  const [expanded, setExpanded] = useState(false);
  const openThread = useOpenLinkedThread();
  const senderTitle = liveTitle || details.name || "Thread";
  return (
    <View className="min-w-0">
      <View className="min-w-0 flex-row items-center gap-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[
            `${details.label} ${sender ? senderTitle : (details.name ?? "")}`.trim(),
            details.preview,
          ]
            .filter(Boolean)
            .join(": ")}
          accessibilityState={{ expanded }}
          // The sender link sits inside this button, which screen readers treat as one element.
          accessibilityActions={
            sender ? [{ name: "openThread", label: `Open ${senderTitle}` }] : undefined
          }
          onAccessibilityAction={(event) => {
            if (sender && event.nativeEvent.actionName === "openThread") openThread(sender);
          }}
          onPress={() => setExpanded(!expanded)}
          className="min-h-8 min-w-0 flex-1 flex-row items-center gap-1.5 py-0.5"
        >
          <View className="w-6 shrink-0 items-center">
            <SymbolView
              name={sender ? "bubble.left" : "gearshape"}
              size={16}
              tintColorClassName="accent-foreground-muted"
            />
          </View>
          <Text className="shrink-0 text-sm text-foreground-muted">{details.label}</Text>
          {sender ? (
            <ThreadMessageLink thread={sender} title={senderTitle} />
          ) : details.name ? (
            <Text
              numberOfLines={1}
              className="min-w-0 shrink font-t3-bold text-sm text-foreground-muted"
            >
              {details.name}
            </Text>
          ) : null}
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground-subtle">
            {details.preview ? `· ${details.preview}` : ""}
          </Text>
          {props.createdAt ? (
            <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
              {new Date(props.createdAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          ) : null}
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
        <MessageReactionChip reaction={props.reaction} />
      </View>
      {expanded ? (
        <View
          className="ml-7 mb-1.5 mt-0.5 min-w-0 border-l-2 border-l-border pl-3"
          style={{
            ...(color ? { borderLeftColor: color } : {}),
            borderStyle: props.queued ? "dashed" : "solid",
          }}
        >
          {props.children ?? <Text className="text-sm text-foreground">{props.text}</Text>}
        </View>
      ) : null}
    </View>
  );
}

export function ThreadMessageLink(props: {
  readonly thread: ScopedThreadRef;
  readonly title?: string;
}) {
  const shell = useQuietThreadShell(props.thread);
  const liveTitle = useThreadTitle(props.thread);
  const title = props.title ?? (liveTitle?.trim() || "Thread");
  const glyph = resolveThreadGlyph(props.thread.threadId, shell?.glyphSeed);
  const { themeAppearance } = useAppearancePreferences();
  const color = themeAppearance === "dark" ? glyph.color : glyph.lightColor;
  const openThread = useOpenLinkedThread();
  return (
    <Pressable
      className="min-w-0 shrink flex-row items-center gap-1.5"
      accessibilityRole="link"
      accessibilityLabel={title}
      onPress={(event) => {
        event.stopPropagation();
        openThread(props.thread);
      }}
    >
      <Svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {glyph.paths.map((path) => (
          <Path key={path} d={path} />
        ))}
      </Svg>
      <Text
        numberOfLines={1}
        className="min-w-0 shrink font-t3-bold text-sm text-foreground-muted"
        style={{ color }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
