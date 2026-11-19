import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { leaderEnabled, matchesKeybindingShortcut } from "@t3tools/shared/keybindings";
import type { ShortcutEventLike } from "../keybindings";

export const LEADER_TIMEOUT_MS = 1500;

/** Owns the pending prefix; the caller resolves the second key in its current focus context. */
export function createLeaderHandler(input: {
  keybindings: () => ResolvedKeybindingsConfig;
  platform: () => string;
  changed: (active: boolean) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!active) return;
    active = false;
    input.changed(false);
  };
  return {
    cancel,
    handle(event: ShortcutEventLike): "prefix" | "sequence" | "cancel" | "passthrough" | null {
      const config = input.keybindings();
      const leader = config.findLast((rule) => rule.command === "keybindings.leader");
      if (!leader || !leaderEnabled(config)) {
        cancel();
        return null;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
      const prefix = matchesKeybindingShortcut(event, leader.shortcut, input.platform());
      if (active) {
        if (event.repeat) return "prefix";
        cancel();
        if (prefix) return "passthrough";
        return event.key === "Escape" ? "cancel" : "sequence";
      }
      if (!prefix) return null;
      if (!event.repeat) {
        active = true;
        input.changed(true);
        timer = setTimeout(cancel, LEADER_TIMEOUT_MS);
      }
      return "prefix";
    },
  };
}
