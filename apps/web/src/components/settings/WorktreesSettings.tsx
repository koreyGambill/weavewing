import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { WorktreeProvider } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

import { AdvancedSettings } from "./AdvancedSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";
import { WorktreeSubmodulesRow } from "./ProjectDefaultsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WorktreeCleanupSection, WorktreesDirectoryRow } from "./StorageSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const WORKTREE_PROVIDER_LABELS: Record<WorktreeProvider, string> = {
  t3: "T3 worktrees",
  xwing: "Xwing environments",
  off: "Off",
};

function WorktreeProviderRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreeProvider"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["worktreeProvider"]}
      {...searchableSetting("worktree-provider")}
      description="Who makes a separate checkout when a thread, task or pull request asks for one. Xwing gives each new isolated thread its own Xwing environment. Off keeps threads in existing checkouts."
      resetAction={
        mixed || settings.worktreeProvider !== DEFAULT_UNIFIED_SETTINGS.worktreeProvider ? (
          <SettingResetButton
            label="isolated checkouts"
            onClick={() =>
              updateSettings({ worktreeProvider: DEFAULT_UNIFIED_SETTINGS.worktreeProvider })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.worktreeProvider}
          onValueChange={(value) => {
            if (value === "t3" || value === "xwing" || value === "off")
              updateSettings({ worktreeProvider: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Isolated checkouts">
            <SelectValue>
              {(value: string | null) =>
                value === "t3" || value === "xwing" || value === "off"
                  ? WORKTREE_PROVIDER_LABELS[value]
                  : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(Object.keys(WORKTREE_PROVIDER_LABELS) as WorktreeProvider[]).map((provider) => (
              <SelectItem key={provider} value={provider}>
                {WORKTREE_PROVIDER_LABELS[provider]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function StartFromRemoteRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesStartFromOrigin"]}
      {...searchableSetting("start-from-origin")}
      description="Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing."
      resetAction={
        settings.newWorktreesStartFromOrigin !==
        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
          <SettingResetButton
            label="new worktrees start from remote"
            onClick={() =>
              updateSettings({
                newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newWorktreesStartFromOrigin"]}
          checked={settings.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
          }
          aria-label="Start new worktrees from remote by default"
        />
      }
    />
  );
}

export function WorktreesSettingsPanel() {
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsPageContainer>
      <SettingsSection id="worktree-creation" title="Creation">
        {!isProjectScope && <WorktreeProviderRow />}
        {!isProjectScope && <WorktreesDirectoryRow />}
        <StartFromRemoteRow />
        <AdvancedSettings targetIds={[searchableSetting("worktree-submodules").id]}>
          <WorktreeSubmodulesRow />
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title="Branches">
        <BranchNamingSettings />
      </SettingsSection>
      <WorktreeCleanupSection />
    </SettingsPageContainer>
  );
}
