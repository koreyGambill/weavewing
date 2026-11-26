import type { InputMessageReaction } from "@t3tools/client-runtime/state/message-reactions";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";

/** Icon-only, like web's badge; the expanded card spells the reaction out. */
export function MessageReactionChip({
  reaction,
}: {
  readonly reaction?: InputMessageReaction | undefined;
}) {
  return reaction ? (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={reaction.tooltip}
      className="h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-border px-1"
    >
      <SymbolView
        name={
          reaction.kind === "ack"
            ? "checkmark.circle"
            : reaction.kind === "replied"
              ? "arrow.uturn.backward"
              : "info.circle"
        }
        size={11}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
    </View>
  ) : null;
}
