import { leaderShortcutKey } from "@t3tools/shared/keybindings";
import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@t3tools/contracts";
import { useState } from "react";
import { formatShortcutLabel, formatShortcutKeyLabel } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { commandLabel } from "../settings/KeybindingsSettings.logic";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";

const workspaceOrder: readonly KeybindingCommand[] = [
  "workspace.tile.focusLeft",
  "workspace.tile.focusRight",
  "workspace.tile.focusUp",
  "workspace.tile.focusDown",
  "workspace.tile.previousTab",
  "workspace.tile.nextTab",
  "workspace.tile.maximize",
  "workspace.tile.resize",
  "workspace.tile.focusPair",
  "workspace.tile.swap",
  "workspace.tile.float",
  "workspace.tile.newTab",
  "workspace.tile.closeTab",
  "workspace.tile.actions",
  "workspace.tile.splitLeft",
  "workspace.tile.splitRight",
  "workspace.tile.splitUp",
  "workspace.tile.splitDown",
  "workspace.focusNext",
  "workspace.focusPrevious",
];

export function ShortcutReferenceDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Shortcut reference</DialogTitle>
        </DialogHeader>
        {open ? <ShortcutReferenceContent /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function ShortcutReferenceContent() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [query, setQuery] = useState("");
  const shortcuts = new Map<KeybindingCommand, Set<string>>();
  for (const binding of keybindings) {
    const keys = shortcuts.get(binding.command) ?? new Set<string>();
    const leader = keybindings.findLast((rule) => rule.command === "keybindings.leader")?.shortcut;
    keys.add(
      binding.shortcut.leader
        ? `${leader ? formatShortcutLabel(leader) : "Ctrl+A"} then ${formatShortcutKeyLabel(leaderShortcutKey(binding.shortcut))}`
        : formatShortcutLabel(binding.shortcut),
    );
    shortcuts.set(binding.command, keys);
  }
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = [...shortcuts]
    .map(([command, keys]) => ({ command, keys: [...keys], label: commandLabel(command) }))
    .filter((row) =>
      words.every((word) =>
        `${row.label} ${row.command} ${row.keys.join(" ")}`.toLowerCase().includes(word),
      ),
    )
    .toSorted((a, b) => {
      const aIndex = workspaceOrder.indexOf(a.command);
      const bIndex = workspaceOrder.indexOf(b.command);
      return (
        (aIndex < 0 ? workspaceOrder.length : aIndex) -
          (bIndex < 0 ? workspaceOrder.length : bIndex) || a.label.localeCompare(b.label)
      );
    });
  const sections = [
    { label: "Workspace", rows: rows.filter((row) => row.command.startsWith("workspace.")) },
    { label: "More", rows: rows.filter((row) => !row.command.startsWith("workspace.")) },
  ];
  return (
    <>
      <div className="px-6 pb-4">
        <Input
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <DialogPanel>
        {sections
          .filter((section) => section.rows.length)
          .map((section) => (
            <section key={section.label} aria-label={section.label}>
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">{section.label}</h2>
              <dl className="divide-y divide-border/50">
                {section.rows.map((row) => (
                  <div key={row.command} className="flex items-center justify-between gap-4 py-2">
                    <dt className="min-w-0 text-sm">{row.label}</dt>
                    <dd className="flex max-w-3/5 shrink-0 flex-wrap justify-end gap-1">
                      {row.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        {!rows.length ? (
          <p className="text-sm text-muted-foreground">No matching shortcuts.</p>
        ) : null}
      </DialogPanel>
    </>
  );
}
