import { waitingTotal, type WaitingCounts } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";

/**
 * A thread row's count of items waiting on the user; nothing when none waits. The row speaks it
 * in its own label, since a screen reader focuses the row as one element.
 */
export function ThreadWaitingBadge(props: {
  readonly counts: WaitingCounts | undefined;
  readonly foregroundClassName?: string;
  readonly iconTintClassName?: string;
}) {
  const total = waitingTotal(props.counts);
  if (total === 0) return null;
  return (
    <View
      className="flex-row items-center gap-0.5"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SymbolView
        name="person.badge.clock"
        size={12}
        tintColorClassName={props.iconTintClassName ?? "accent-primary-text"}
        type="monochrome"
      />
      <Text
        className={cn(
          "text-xs font-t3-bold tabular-nums",
          props.foregroundClassName ?? "text-primary-text",
        )}
      >
        {total}
      </Text>
    </View>
  );
}
