import type { KeybindingCommand } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import {
  KeybindingSettingsRow,
  LeaderSettingsSection,
  NewKeybindingSettingsRow,
  useKeybindingEditing,
} from "../settings/KeybindingsSettings";
import { commandLabel } from "../settings/KeybindingsSettings.logic";
import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

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

const noScopeChange = () => {};

export function ShortcutReferenceDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Shortcut reference</DialogTitle>
        </DialogHeader>
        {open ? (
          // The unscoped Settings view: edits reach every connected environment.
          <SettingsScopeProvider search={{}} onChange={noScopeChange}>
            <ShortcutReferenceContent />
          </SettingsScopeProvider>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ShortcutReferenceContent() {
  const {
    canWriteSettings,
    connectedEnvironments,
    commandOptions,
    allRows,
    leaderOn,
    whenVariables,
    rowActions,
    savingCommand,
    isAddingBinding,
    setIsAddingBinding,
    saveKeybinding,
  } = useKeybindingEditing();
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = allRows.filter((row) =>
    words.every((word) =>
      `${commandLabel(row.command)} ${row.command} ${row.key}`.toLowerCase().includes(word),
    ),
  );
  const showLeader = matching.some((row) => row.command === "keybindings.leader");
  const rows = matching
    .filter((row) => row.command !== "keybindings.leader")
    .toSorted((a, b) => {
      const aIndex = workspaceOrder.indexOf(a.command);
      const bIndex = workspaceOrder.indexOf(b.command);
      return (
        (aIndex < 0 ? workspaceOrder.length : aIndex) -
          (bIndex < 0 ? workspaceOrder.length : bIndex) ||
        commandLabel(a.command).localeCompare(commandLabel(b.command)) ||
        a.key.localeCompare(b.key)
      );
    });
  const sections = [
    { label: "Workspace", rows: rows.filter((row) => row.command.startsWith("workspace.")) },
    { label: "More", rows: rows.filter((row) => !row.command.startsWith("workspace.")) },
  ];
  return (
    <>
      <div className="flex items-center gap-2 px-6 pb-4">
        <Input
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={isAddingBinding || !canWriteSettings}
          onClick={() => setIsAddingBinding(true)}
        >
          <PlusIcon aria-hidden className="size-4" />
          Add keybinding
        </Button>
      </div>
      <DialogPanel>
        <div inert={!canWriteSettings} className="flex flex-col gap-6">
          {isAddingBinding ? (
            <SettingsGroup>
              <NewKeybindingSettingsRow
                commandOptions={commandOptions}
                allRows={allRows}
                variables={whenVariables}
                isSaving={savingCommand !== null}
                onSave={saveKeybinding}
                onCancel={() => setIsAddingBinding(false)}
              />
            </SettingsGroup>
          ) : null}
          {showLeader ? (
            <LeaderSettingsSection
              allRows={allRows}
              leaderOn={leaderOn}
              savingCommand={savingCommand}
              saveKeybinding={saveKeybinding}
              rowActions={rowActions}
            />
          ) : null}
          {sections
            .filter((section) => section.rows.length)
            .map((section) => (
              <SettingsSection key={section.label} title={section.label} aria-label={section.label}>
                <SettingsGroup>
                  {section.rows.map((row) => (
                    <KeybindingSettingsRow
                      key={row.id}
                      row={row}
                      isSaving={savingCommand === row.command}
                      {...rowActions}
                    />
                  ))}
                </SettingsGroup>
              </SettingsSection>
            ))}
        </div>
        {!rows.length && !showLeader ? (
          <p className="text-sm text-muted-foreground">No matching shortcuts.</p>
        ) : null}
        {!canWriteSettings ? (
          <p className="text-xs text-muted-foreground">
            {connectedEnvironments.length === 0
              ? "Connect an environment to change keybindings."
              : "This connection can view keybindings but cannot change them."}
          </p>
        ) : null}
      </DialogPanel>
    </>
  );
}
