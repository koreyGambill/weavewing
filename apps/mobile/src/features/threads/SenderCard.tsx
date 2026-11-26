import { resolveThreadGlyph } from "@t3tools/client-runtime/thread-glyphs";
import { senderCardDetails } from "@t3tools/client-runtime/user-message";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentServerConfig } from "../../state/entities";
import { CopyTextButton } from "./CopyTextButton";
import { MessageReactionChip } from "./MessageReactionChip";
import { senderCardRowLabel, type IncomingOrigin } from "./messageCards";
import { useMessageReaction } from "./useMessageReaction";
import { ThreadDisclosureChevron } from "./thread-work-log";
import { ThreadMessageLink, useThreadCardTarget } from "./ThreadMessageLink";
import { WorkLogIconSlot } from "./work-log-layout";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

// Web's breakpoints for the card: below them the relation label shortens, then the time leaves.
const LABEL_MIN_WIDTH = 576;
const TIMESTAMP_MIN_WIDTH = 384;
/** The expanded body's left margin, border and padding (`ml-7 border-l-2 pl-3`). */
export const SENDER_CARD_BODY_INSET = 42;

/** A message another thread, task or the app sent: one line that expands to the full text. */
export function SenderCard(props: {
  readonly origin: IncomingOrigin;
  /** The thread that received the message; decides whether the sender is its child. */
  readonly threadRef: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly text: string;
  readonly summary: string | undefined;
  readonly timestampLabel: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly width: number;
  readonly themeAppearance: "light" | "dark";
  readonly iconSubtleColor: ColorValue;
  readonly children: ReactNode;
}) {
  const sender = "threadId" in props.origin ? props.origin : null;
  const target = useThreadCardTarget(sender, sender?.title);
  const reaction = useMessageReaction(props.threadRef, props.messageId);
  const openThread = useOpenLinkedThread();
  const summariesOn =
    useEnvironmentServerConfig(props.threadRef.environmentId)?.settings.incomingCardSummaries !==
    false;
  const details = senderCardDetails(
    props.origin,
    props.text,
    props.threadRef,
    target.shell,
    summariesOn ? props.summary : undefined,
  );
  const name = sender ? target.title : details.name;
  const heading = `${details.label} ${name ?? ""}`.trim();
  const glyph = sender ? resolveThreadGlyph(sender.threadId, target.shell?.glyphSeed) : null;
  const accent = glyph
    ? props.themeAppearance === "dark"
      ? glyph.color
      : glyph.lightColor
    : undefined;
  const canOpen = sender !== null && target.reachable;
  return (
    <View className="mb-1 min-w-0">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[heading, details.preview, reaction?.label].filter(Boolean).join(": ")}
        accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the message.`}
        accessibilityState={{ expanded: props.expanded }}
        // Screen readers treat the row as one element, so the sender link is an action on it.
        accessibilityActions={canOpen ? [{ name: "openThread", label: `Open ${name}` }] : undefined}
        onAccessibilityAction={(event) => {
          if (canOpen && event.nativeEvent.actionName === "openThread") {
            openThread({
              environmentId: String(sender.environmentId),
              threadId: String(sender.threadId),
            });
          }
        }}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        className="min-h-11 flex-row items-center gap-1.5 rounded-md px-0.5 active:bg-subtle"
      >
        <WorkLogIconSlot>
          <SymbolView
            name={sender ? "bubble.left" : "gearshape"}
            size={14}
            weight="medium"
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </WorkLogIconSlot>
        <View className="min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden">
          <Text numberOfLines={1} className="min-w-0 shrink text-sm text-foreground-muted">
            {senderCardRowLabel(details.label, Boolean(name), props.width >= LABEL_MIN_WIDTH)}
          </Text>
          {sender ? (
            <View className="min-w-0 max-w-[45%] shrink">
              <ThreadMessageLink
                thread={sender}
                title={target.title}
                glyphSeed={target.shell?.glyphSeed}
                reachable={target.reachable}
                themeAppearance={props.themeAppearance}
              />
            </View>
          ) : details.name ? (
            <Text
              numberOfLines={1}
              className="min-w-0 max-w-[45%] shrink font-t3-medium text-sm text-foreground-muted"
            >
              {details.name}
            </Text>
          ) : null}
          {details.preview ? (
            <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground-secondary">
              {`· ${details.preview}`}
            </Text>
          ) : null}
        </View>
        <View className="shrink-0 flex-row items-center gap-1">
          {props.width >= TIMESTAMP_MIN_WIDTH ? (
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
              {props.timestampLabel}
            </Text>
          ) : null}
          <MessageReactionChip reaction={reaction} />
          <View className="h-4 w-4 items-center justify-center">
            <ThreadDisclosureChevron
              expanded={props.expanded}
              collapsedDirection="down"
              size={11}
              tintColor={props.iconSubtleColor}
            />
          </View>
        </View>
      </Pressable>
      {props.expanded ? (
        <View
          className="mb-1.5 ml-7 mt-0.5 min-w-0 gap-2 border-l-2 border-l-border pl-3"
          style={accent ? { borderLeftColor: accent } : undefined}
        >
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-xs text-foreground-secondary">
              {[heading, reaction?.label, props.timestampLabel].filter(Boolean).join(" · ")}
            </Text>
            {props.text.trim().length > 0 ? (
              // A full-size target whose margin keeps the header line compact.
              <View className="-my-2.5">
                <CopyTextButton
                  accessibilityLabel="Copy message"
                  text={props.text}
                  tintColor={props.iconSubtleColor}
                  buttonSize={44}
                  iconSize={13}
                />
              </View>
            ) : null}
          </View>
          {props.children}
        </View>
      ) : null}
    </View>
  );
}
