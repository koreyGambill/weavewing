import { isManagedSettingPath } from "@t3tools/contracts";
import { ManagedNotice } from "../ManagedPolicy";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// Weavewing: use the shared settings scope so policy locks apply to every selected environment.
export function RemoteMediaSettingsRow() {
  const checked = useScopedSettings((settings) => settings.autoLoadRemoteMedia);
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const policy = connectedEnvironments
    .map((environment) => environment.serverConfig?.managedPolicy)
    .find((policy) => policy && isManagedSettingPath(policy, "autoLoadRemoteMedia"));
  return (
    <SettingsRow
      {...searchableSetting("auto-load-remote-media")}
      className="wrap-anywhere @max-[20rem]/settings-row:[&>div>div>div:first-child]:flex-wrap @max-[20rem]/settings-row:[&_h3]:w-full"
      serverScoped
      settingKeys={["autoLoadRemoteMedia"]}
      description="Images from web addresses in chat load without a click; the site sees your IP and the full address."
      status={policy ? <ManagedNotice>Managed by {policy.organization}.</ManagedNotice> : undefined}
      control={
        <ScopedSwitch
          settingKeys={["autoLoadRemoteMedia"]}
          checked={checked}
          onCheckedChange={(checked) => updateSettings({ autoLoadRemoteMedia: checked })}
          aria-label="Load remote images automatically"
        />
      }
    />
  );
}
