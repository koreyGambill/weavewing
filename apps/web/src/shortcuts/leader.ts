import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { leaderEnabled, matchesKeybindingShortcut } from "@t3tools/shared/keybindings";
import type { ShortcutEventLike } from "../keybindings";

const LEADER_TIMEOUT_MS = 200;

/** Owns the pending prefix; the caller resolves the second key in its current focus context. */
export function createLeaderHandler(input: {
  keybindings: () => ResolvedKeybindingsConfig;
  platform: () => string;
  changed: (active: boolean) => void;
  prepareDefaultTimeout?: (event: ShortcutEventLike) => (() => void) | undefined;
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
        const { key, ctrlKey, shiftKey, altKey, metaKey, modKey } = leader.shortcut;
        const onTimeout =
          key === "a" && ctrlKey && !shiftKey && !altKey && !metaKey && !modKey
            ? input.prepareDefaultTimeout?.(event)
            : undefined;
        timer = setTimeout(() => {
          cancel();
          onTimeout?.();
        }, LEADER_TIMEOUT_MS);
      }
      return "prefix";
    },
  };
}
