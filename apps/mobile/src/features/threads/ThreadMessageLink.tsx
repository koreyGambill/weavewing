import { resolveThreadGlyph } from "@t3tools/client-runtime/thread-glyphs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { threadCardReachable } from "./messageCards";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** The live title of a thread a card names, and whether this phone can open it. */
export function useThreadCardTarget(ref: ScopedThreadRef | null, fallbackTitle?: string) {
  const shell = useQuietThreadShell(ref);
  const phase =
    useEnvironmentPresentation(ref?.environmentId ?? null).presentation?.connection.phase ?? null;
  const lookup = useEnvironmentQuery(
    ref !== null && shell === null && phase === "connected"
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId: ref.environmentId,
          input: { threadIds: [ref.threadId] },
        })
      : null,
  );
  const metadata = ref && lookup.data ? lookup.data[ref.threadId] : undefined;
  return {
    shell,
    title: shell?.title.trim() || metadata?.title.trim() || fallbackTitle?.trim() || "Thread",
    reachable:
      ref !== null &&
      threadCardReachable({
        phase,
        shellKnown: shell !== null,
        lookupFound: metadata !== undefined,
      }),
  };
}

/** A thread's glyph and title; a link only when the thread can be opened from here. */
export function ThreadMessageLink(props: {
  readonly thread: ScopedThreadRef;
  readonly title: string;
  readonly glyphSeed: number | undefined;
  readonly reachable: boolean;
  readonly themeAppearance: "light" | "dark";
}) {
  const openThread = useOpenLinkedThread();
  const glyph = resolveThreadGlyph(props.thread.threadId, props.glyphSeed);
  const color = props.themeAppearance === "dark" ? glyph.color : glyph.lightColor;
  const content = (
    <>
      <Svg
        width={14}
        height={14}
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
        className="min-w-0 shrink font-t3-medium text-sm text-foreground-muted"
      >
        {props.title}
      </Text>
    </>
  );
  return props.reachable ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${props.title}`}
      // Its own 44 pt box, so the hit area matches the layout and never reaches a neighbour.
      className="min-h-11 min-w-11 shrink flex-row items-center gap-1 self-stretch px-1"
      onPress={(event) => {
        event.stopPropagation();
        openThread({
          environmentId: String(props.thread.environmentId),
          threadId: String(props.thread.threadId),
        });
      }}
    >
      {content}
    </Pressable>
  ) : (
    <View className="min-w-0 shrink flex-row items-center gap-1">{content}</View>
  );
}
