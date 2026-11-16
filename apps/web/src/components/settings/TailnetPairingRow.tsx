import { useRef } from "react";
import type { EnvironmentId, TailnetConnectSettings } from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ManagedNotice } from "../ManagedPolicy";
import { useManagedPolicy } from "~/state/managedPolicy";
import { isManagedSettingPath } from "@t3tools/contracts";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const parseLogins = (value: string) => [
  ...new Set(
    value
      .split(/[\s,]+/u)
      .map((login) => login.trim())
      .filter((login) => login.length > 0),
  ),
];

/** Lets the user's own tailnet devices pair from this server's /tailnet page. */
export function TailnetPairingRow({
  environmentId,
  environmentLabel,
  settings,
  managed,
  privacy = false,
  canWrite = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly settings: TailnetConnectSettings;
  readonly managed: string | undefined;
  readonly privacy?: boolean;
  readonly canWrite?: boolean;
}) {
  const policy = useManagedPolicy(environmentId);
  const settingLockReason = isManagedSettingPath(policy, "tailnetConnect.enabled")
    ? `Managed by ${policy?.organization}.`
    : undefined;
  const policyReason = settingLockReason ?? managed;
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const loginsEdited = useRef(false);
  const savedLogins = settings.allowedLogins.join(", ");

  return (
    <SettingsRow
      {...searchableSetting("tailnet-pairing")}
      description={
        <>
          Open <code>/tailnet</code> at {environmentLabel}'s Tailscale address on a phone or laptop
          to pair with all your T3 Code servers, without copying a code.
        </>
      }
      managed={
        settingLockReason ??
        (!canWrite
          ? "This connection cannot change access settings."
          : settings.enabled
            ? undefined
            : managed)
      }
      status={privacy && policyReason ? <ManagedNotice>{policyReason}</ManagedNotice> : null}
      control={
        <>
          <span className="min-w-0 max-w-48 truncate text-xs text-muted-foreground" aria-hidden>
            For {environmentLabel}
          </span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) =>
              updateSettings({ tailnetConnect: { enabled: Boolean(checked) } })
            }
            aria-label={`Tailnet pairing for ${environmentLabel}`}
          />
        </>
      }
    >
      {settings.enabled ? (
        <div
          inert={!canWrite || isManagedSettingPath(policy, "tailnetConnect.allowedLogins")}
          className="mt-2 mb-3 flex max-w-xl flex-col gap-1.5 border-l-2 border-border/60 ps-3"
        >
          <label htmlFor="tailnet-allowed-logins" className="text-xs font-medium">
            Allowed Tailscale logins
          </label>
          <Input
            id="tailnet-allowed-logins"
            key={savedLogins}
            size="sm"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="This machine's Tailscale owner"
            defaultValue={savedLogins}
            onChange={() => {
              loginsEdited.current = true;
            }}
            onBlur={(event) => {
              const logins = parseLogins(event.target.value);
              if (loginsEdited.current && logins.join(", ") !== savedLogins) {
                updateSettings({ tailnetConnect: { allowedLogins: logins } });
              }
              loginsEdited.current = false;
            }}
          />
          <p className="text-xs text-muted-foreground">
            Separate logins with commas. Empty allows only the login that owns this machine in
            Tailscale. Tagged and shared devices can never pair.
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}
