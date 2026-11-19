import { useSyncExternalStore } from "react";
import { leaderShortcutKey } from "@t3tools/shared/keybindings";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { formatShortcutKeyLabel, shortcutLabelForCommand } from "../../keybindings";
import { readLeaderActive, subscribeLeader } from "../../shortcuts/dispatcher";
import { commandLabel } from "../settings/KeybindingsSettings.logic";

export function LeaderHint({ keybindings }: { keybindings: ResolvedKeybindingsConfig }) {
  const active = useSyncExternalStore(subscribeLeader, readLeaderActive);
  const sequences = keybindings.filter((rule) => rule.shortcut.leader);
  const tabKeys = sequences.filter((rule) => rule.command.startsWith("workspace.tile.tab."));
  const numberedTabs =
    tabKeys.length === 9 &&
    tabKeys.every((rule) => leaderShortcutKey(rule.shortcut) === rule.command.at(-1));
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed bottom-4 right-4 z-50"
    >
      {active ? (
        <div className="max-h-[70vh] max-w-80 overflow-y-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
          <p className="mb-2 text-xs font-medium">
            {shortcutLabelForCommand(keybindings, "keybindings.leader")} then…
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {sequences
              .filter((rule) => !numberedTabs || !rule.command.startsWith("workspace.tile.tab."))
              .map((rule) => (
                <div key={`${rule.command}:${rule.shortcut.key}`} className="contents">
                  <dt className="font-mono">
                    {formatShortcutKeyLabel(leaderShortcutKey(rule.shortcut))}
                  </dt>
                  <dd>{commandLabel(rule.command)}</dd>
                </div>
              ))}
            {numberedTabs ? (
              <>
                <dt className="font-mono">1–9</dt>
                <dd>Jump to tab</dd>
              </>
            ) : null}
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            Esc cancels · Repeat leader to send it through
          </p>
        </div>
      ) : null}
    </div>
  );
}
