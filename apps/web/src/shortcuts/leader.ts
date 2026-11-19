import type { KeybindingShortcut, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { leaderEnabled, matchesKeybindingShortcut } from "@t3tools/shared/keybindings";
import type { ShortcutEventLike } from "../keybindings";

const LEADER_TIMEOUT_MS = 200;

function sameShortcut(left: KeybindingShortcut, right: KeybindingShortcut | undefined): boolean {
  return (
    right !== undefined &&
    left.key === right.key &&
    left.leader === right.leader &&
    left.ctrlKey === right.ctrlKey &&
    left.shiftKey === right.shiftKey &&
    left.altKey === right.altKey &&
    left.metaKey === right.metaKey &&
    left.modKey === right.modKey
  );
}

/** Owns the pending prefix; the caller resolves the second key in its current focus context. */
export function createLeaderHandler(input: {
  keybindings: () => ResolvedKeybindingsConfig;
  platform: () => string;
  changed: (active: boolean) => void;
  prepareDefaultTimeout?: (event: ShortcutEventLike) => (() => void) | undefined;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: KeybindingShortcut | undefined;
  const readShortcut = () => {
    const config = input.keybindings();
    return leaderEnabled(config)
      ? config.findLast((rule) => rule.command === "keybindings.leader")?.shortcut
      : undefined;
  };
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    pending = undefined;
    input.changed(false);
  };
  return {
    cancel,
    handle(event: ShortcutEventLike): "prefix" | "sequence" | "cancel" | "passthrough" | null {
      const shortcut = readShortcut();
      if (pending && !sameShortcut(pending, shortcut)) cancel();
      if (!shortcut) return null;
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
      const prefix = matchesKeybindingShortcut(event, shortcut, input.platform());
      if (pending) {
        if (event.repeat) return "prefix";
        cancel();
        if (prefix) return "passthrough";
        return event.key === "Escape" ? "cancel" : "sequence";
      }
      if (!prefix) return null;
      if (!event.repeat) {
        pending = shortcut;
        input.changed(true);
        const { key, ctrlKey, shiftKey, altKey, metaKey, modKey } = shortcut;
        const onTimeout =
          key === "a" && ctrlKey && !shiftKey && !altKey && !metaKey && !modKey
            ? input.prepareDefaultTimeout?.(event)
            : undefined;
        timer = setTimeout(() => {
          const unchanged = sameShortcut(shortcut, readShortcut());
          cancel();
          if (unchanged) onTimeout?.();
        }, LEADER_TIMEOUT_MS);
      }
      return "prefix";
    },
  };
}
