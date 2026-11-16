import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkState } from "~/cloud/cloudLinkState";
import { useEnvironment } from "~/state/environments";
import { Button } from "../ui/button";
import { MobileAppSettingsRow } from "./MobileAppSettingsRow";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function PrivacyDeviceRows({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <>
      <SettingsRow title="Before you pair the T3 Code app">
        <div className="mb-3 flex gap-2 text-xs leading-relaxed text-muted-foreground">
          <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <ul className="min-w-0 list-disc space-y-2 pl-4">
            <li>
              The app is made by T3, not Weavewing, and sends crash reports to T3 by default. Turn
              them off in the app before you pair: Settings → About → Diagnostics.
            </li>
            <li>
              It loads images in threads automatically, so a link an agent writes is fetched by your
              phone.
            </li>
            <li>
              Weavewing serves plain HTTP, so connect over Tailscale or a VPN, not an open network.
            </li>
          </ul>
        </div>
      </SettingsRow>
      <MobileAppSettingsRow />
      <SettingsRow
        title="Pair a device"
        description="Create a one-time pairing link or QR code."
        control={
          <Button
            variant="outline"
            size="sm"
            render={
              <Link
                to="/settings/access"
                search={{ machine: environmentId }}
                hash="authorized-clients"
              />
            }
          >
            Open pairing
          </Button>
        }
      />
    </>
  );
}

export function PrivacySettings({
  environmentId,
  networkAccessible,
  children,
}: {
  environmentId: EnvironmentId;
  networkAccessible: boolean;
  children?: ReactNode;
}) {
  const environment = useEnvironment(environmentId);
  const relay = useCloudLinkState(environmentId);
  const remote =
    networkAccessible || environment?.serverConfig?.settings.tailnetConnect.enabled === true;
  const relayState = !hasCloudPublicConfig()
    ? "Not in this build"
    : relay.data === null
      ? relay.error
        ? "Unavailable"
        : "Unknown"
      : relay.data.linked && !relay.data.linkRevoked && relay.data.managedTunnelActive !== false
        ? "On"
        : "Off";
  return (
    <>
      {/* The Chat content row from the remote-media slice belongs before the summary. */}
      {children}
      <SettingsSection {...searchableSetting("what-weavewing-sends")}>
        <SettingsRow
          title="Your providers"
          description="Prompts, files and tool output go to the provider you pick for each thread. Titles, commit messages and summaries use that thread's model. Signed-in providers also check your usage limits."
          control={
            <Button variant="outline" size="sm" render={<Link to="/settings/providers" />}>
              Providers
            </Button>
          }
        />
        <SettingsRow
          title="Git and GitHub"
          description="Git fetches each open project's remote every 30 seconds, and gh looks up pull requests once you sign it in."
          control={
            <Button variant="outline" size="sm" render={<Link to="/settings/source-control" />}>
              Source control
            </Button>
          }
        />
        <SettingsRow
          title="Update checks"
          description="Weavewing and your provider CLIs check for new versions. These requests disclose version numbers and your IP address."
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                render={<Link to="/settings/maintenance" hash="provider-update-checks" />}
              >
                Provider checks
              </Button>
              <Button variant="outline" size="sm" render={<Link to="/settings/about" />}>
                About
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Only when you act"
          description="Opening a link, signing in, installing a provider, theme search, dictation models and the browser panel contact those sites when you use them. So do your agents' own web tools."
        />
        <SettingsRow
          title="Never"
          description="No analytics, no crash reports, no favicon lookups."
        />
        <SettingsRow
          title="Remote routes"
          description={`Remote devices: ${remote ? "On" : "Off"}. T3 Connect: ${relayState}.`}
        />
      </SettingsSection>
    </>
  );
}
