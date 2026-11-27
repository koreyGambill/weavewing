import { useAtomValue } from "@effect/atom-react";
import {
  contextBreakdown,
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { useState } from "react";
import { Keyboard, Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { FitSheet } from "../../components/ui/FitSheet";
import { Sheet } from "../../components/ui/Sheet";
import { environmentThreadDetails } from "../../state/threads";
import { useQuietThreadStructure } from "../../state/use-thread-detail";

const ThemedCircle = withUniwind(Circle);
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ComposerContextMeter({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const projection = useQuietThreadStructure(threadRef);
  const entries = useAtomValue(environmentThreadDetails.quietVisibleTurnItemsAtom(threadRef));
  const [open, setOpen] = useState(false);

  const activeProviderThread = projection?.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const report = latestProviderTurnTokenUsage(
    projection?.providerTurns ?? [],
    projection,
    activeProviderThread,
  );
  const usage = deriveLatestContextWindowSnapshot(entries, report, activeProviderThread);
  if (usage === null) return null;

  const breakdown = contextBreakdown(usage);
  const percent = breakdown.usedPercent;
  const used = formatCount(breakdown.usedTokens);
  const amount =
    breakdown.maxTokens === null
      ? `${used} tokens used`
      : `${used} of ${formatCount(breakdown.maxTokens)} tokens used`;
  const colorClassName =
    breakdown.tone === "critical"
      ? "accent-danger-foreground"
      : breakdown.tone === "warning"
        ? "accent-warning-foreground"
        : "accent-foreground";

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Context: ${amount}${percent === null ? "" : `, ${percent}%`}`}
        onPress={() => {
          Keyboard.dismiss();
          setOpen(true);
        }}
        className="size-[44px] shrink-0 items-center justify-center active:opacity-60"
      >
        {percent === null ? (
          <SymbolView
            name="ellipsis.circle"
            type="monochrome"
            size={18}
            tintColorClassName="accent-icon"
          />
        ) : (
          <Svg width={18} height={18} viewBox="0 0 18 18" accessible={false}>
            <ThemedCircle
              cx={9}
              cy={9}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              colorClassName="accent-icon-subtle"
              strokeWidth={2}
            />
            {percent > 0 ? (
              <ThemedCircle
                cx={9}
                cy={9}
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                colorClassName={colorClassName}
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={[(percent / 100) * RING_CIRCUMFERENCE, RING_CIRCUMFERENCE]}
                rotation={-90}
                originX={9}
                originY={9}
              />
            ) : null}
          </Svg>
        )}
      </Pressable>
      {open ? (
        <Sheet title="Context usage" onClose={() => setOpen(false)}>
          <FitSheet contentContainerClassName="gap-4 px-5 pt-4">
            <Text className="font-t3-medium text-base">
              {percent === null ? amount : `${amount} (${percent}%)`}
            </Text>
            <View className="gap-2">
              {[...breakdown.rows, ...breakdown.kinds].map(({ label, tokens }) => (
                <View key={label} className="flex-row flex-wrap justify-between gap-x-4 gap-y-1">
                  <Text className="text-sm text-foreground-secondary">{label}</Text>
                  <Text className="text-sm tabular-nums">{formatCount(tokens)}</Text>
                </View>
              ))}
            </View>
          </FitSheet>
        </Sheet>
      ) : null}
    </>
  );
}
