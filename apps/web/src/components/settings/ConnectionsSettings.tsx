import { useSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthPairingLink,
  type AdvertisedEndpoint,
  type DesktopServerExposureState,
  EnvironmentId,
  managedCapabilityDenial,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  missingTailscaleEndpointDescription,
  resolveTailscaleServeBaseUrl,
} from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useAccessEnvironment } from "./useAccessEnvironment";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { PrivacyDeviceRows, PrivacySettings } from "./PrivacySettings";
import { ManagedNotice, ManagedByOrganization } from "../ManagedPolicy";
import { searchableSetting } from "./settingsSearch";
import { ConnectDeviceApprovalSettings } from "./ConnectDeviceApprovalSettings";
import { TailnetPairingRow } from "./TailnetPairingRow";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Spinner } from "../ui/spinner";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useUiStateStore } from "~/uiStateStore";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { authEnvironment } from "~/state/auth";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentSessionState,
} from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { useEnvironment, useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  sortDesktopPairingLinks,
  toDesktopPairingLinkRecord,
  selectPairingEndpoint,
  isServerNetworkAccessible,
  isTailscaleHttpsEndpoint,
  endpointDefaultPreferenceKey,
  recentPeerLinkRevokeWarning,
  toDesktopClientSessionRecord,
} from "./ConnectionsSettings.logic";
import { AdvertisedEndpointListRow, NetworkAccessDescription } from "./AuthorizedClientsSettings";
import { CloudLinkRow, CloudRemoteEnvironmentRows } from "./SavedEnvironmentRows";
import {
  type ConnectDeviceRevokeRequest,
  RevokeConnectDeviceDialog,
} from "./RevokeConnectDeviceDialog";
import { APP_BASE_NAME } from "~/branding";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

export function ConnectionsSettings() {
  return <AccessSettings />;
}

function AccessSettings() {
  // A link that names an environment, such as the MCP wizard's, opens the page on it. The
  // settings layout remounts this page when the link changes.
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(linkedEnvironmentId);
  const { candidates, environment: accessEnvironment } =
    useAccessEnvironment(selectedEnvironmentId);
  const accessEnvironmentId = accessEnvironment?.environmentId ?? null;
  const picker =
    candidates.length > 1 && accessEnvironmentId !== null ? (
      <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
        <span className="shrink-0">Showing privacy for</span>
        <Select
          value={accessEnvironmentId}
          onValueChange={(next) => {
            if (next !== null) setSelectedEnvironmentId(next);
          }}
        >
          <SelectTrigger size="sm" className="w-auto max-w-72" aria-label="Environment">
            <SelectValue>
              {(value: EnvironmentId) => {
                const environment = candidates.find(
                  (candidate) => candidate.environmentId === value,
                );
                return environment ? settingsScopeEnvironmentLabel(environment, candidates) : null;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {candidates.map((environment) => (
              <SelectItem
                hideIndicator
                key={environment.environmentId}
                value={environment.environmentId}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    className="size-3.5 shrink-0"
                  />
                  <span className="min-w-0 truncate">
                    {settingsScopeEnvironmentLabel(environment, candidates)}
                  </span>
                  {environment.connection.phase !== "connected" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    ) : null;
  // Keyed so pairing credentials and pending work never carry over to another environment.
  return (
    <ConnectionsSettingsContent
      key={accessEnvironmentId ?? "none"}
      accessEnvironmentId={accessEnvironmentId}
      accessEnvironmentPicker={picker}
    />
  );
}

function ConnectionsSettingsContent({
  accessEnvironmentId,
  accessEnvironmentPicker = null,
}: {
  readonly accessEnvironmentId: EnvironmentId | null;
  readonly accessEnvironmentPicker?: ReactNode;
}) {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const accessEnvironment = useEnvironment(accessEnvironmentId);
  // Desktop network and Tailscale controls change the backend this app spawned.
  const isPrimaryAccess =
    accessEnvironmentId !== null && accessEnvironmentId === primaryEnvironmentId;
  const accessSessionState = useEnvironmentSessionState(accessEnvironmentId);
  const currentAuthPolicy = desktopBridge ? null : (accessSessionState.data?.auth.policy ?? null);
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );
  const [desktopServerExposureMutationError, setDesktopServerExposureMutationError] = useState<
    string | null
  >(null);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [isUpdatingTailscaleServe, setIsUpdatingTailscaleServe] = useState(false);
  const [pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint] =
    useState<AdvertisedEndpoint | null>(null);
  const [disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen] = useState(false);
  const [tailscaleServePortInput, setTailscaleServePortInput] = useState(
    String(DEFAULT_TAILSCALE_SERVE_PORT),
  );
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;
  // Turning remote access off stays possible; only the way in is managed.
  const remoteClientsDenial = managedCapabilityDenial(
    primaryServerConfig?.managedPolicy,
    "remoteClients",
  );
  const tailscaleServeDenial =
    remoteClientsDenial ??
    managedCapabilityDenial(primaryServerConfig?.managedPolicy, "tailscaleServe");
  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );
  const canReadAccess = useEnvironmentScope(accessEnvironmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope);
  const canReadRelay = useEnvironmentScope(accessEnvironmentId, AuthRelayReadScope);
  const canMaintain = useEnvironmentScope(accessEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageRelay = useEnvironmentScope(accessEnvironmentId, AuthRelayWriteScope);
  const canManageLocalBackend = isPrimaryAccess && !isLocalEnvironmentDisabled() && canMaintain;
  const authAccessChanges = useEnvironmentQuery(
    canReadAccess && accessEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: accessEnvironmentId,
          input: null,
        })
      : null,
  );
  const desktopNetworkAccess = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
  );
  const desktopServerExposureState = desktopNetworkAccess.data?.serverExposureState ?? null;
  const desktopAdvertisedEndpoints =
    desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS;
  const desktopServerExposureError =
    desktopServerExposureMutationError ?? desktopNetworkAccess.error;
  const desktopPairingLinks = (() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  })();
  const isLocalBackendNetworkAccessible =
    desktopBridge && isPrimaryAccess
      ? desktopServerExposureState?.mode === "network-accessible"
      : isServerNetworkAccessible({
          authPolicy: currentAuthPolicy,
          directEndpoints: accessEnvironment?.serverConfig?.directEndpoints,
        });
  const trimmedTailscaleServePortInput = tailscaleServePortInput.trim();
  const parsedTailscaleServePort = Number(trimmedTailscaleServePortInput);
  const isTailscaleServePortValid =
    /^\d+$/u.test(trimmedTailscaleServePortInput) &&
    Number.isInteger(parsedTailscaleServePort) &&
    parsedTailscaleServePort >= 1 &&
    parsedTailscaleServePort <= 65_535;

  const pendingTailscaleServeBaseUrl = resolveTailscaleServeBaseUrl(
    pendingTailscaleServeEndpoint,
    parsedTailscaleServePort,
    isTailscaleServePortValid,
  );

  const handleDesktopServerExposureChange = async (checked: boolean) => {
    if (
      !desktopBridge ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsUpdatingDesktopServerExposure(true);
    setDesktopServerExposureMutationError(null);
    try {
      await desktopBridge.setServerExposureMode(checked ? "network-accessible" : "local-only");
      refreshDesktopNetworkAccessState();
      setPendingDesktopServerExposureMode(null);
      setIsUpdatingDesktopServerExposure(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update network exposure.";
      setPendingDesktopServerExposureMode(null);
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change remote device access",
          description: message,
        }),
      );
      setIsUpdatingDesktopServerExposure(false);
    }
  };

  const handleConfirmDesktopServerExposureChange = () => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  };

  const handleConfirmTailscaleServeSetup = async () => {
    if (
      !desktopBridge ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    if (!isTailscaleServePortValid) return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureMutationError(null);
    const settled = await settlePromise(async () => {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: true,
        port: parsedTailscaleServePort,
      });
      refreshDesktopNetworkAccessState();
      setPendingTailscaleServeEndpoint(null);
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message =
        error instanceof Error ? error.message : "Failed to configure Tailscale HTTPS.";
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not set up Tailscale HTTPS",
          description: message,
        }),
      );
    }
    setIsUpdatingTailscaleServe(false);
  };

  const handleStartTailscaleServeSetup = (endpoint: AdvertisedEndpoint) => {
    setTailscaleServePortInput(
      String(desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT),
    );
    setPendingTailscaleServeEndpoint(endpoint);
  };

  const handleConfirmTailscaleServeDisable = async () => {
    if (
      !desktopBridge ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureMutationError(null);
    const settled = await settlePromise(async () => {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: false,
        port: desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      });
      refreshDesktopNetworkAccessState();
      setDisableTailscaleServeDialogOpen(false);
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message = error instanceof Error ? error.message : "Failed to disable Tailscale HTTPS.";
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not disable Tailscale HTTPS",
          description: message,
        }),
      );
    }
    setIsUpdatingTailscaleServe(false);
  };

  const handleStartTailscaleServeDisable = (_endpoint: AdvertisedEndpoint) => {
    setDisableTailscaleServeDialogOpen(true);
  };
  const connectDeviceRequests = desktopPairingLinks.filter(
    (pairingLink) => pairingLink.connectDeviceRequest !== undefined,
  );
  // Older servers omit the list; they cannot hold devices for approval.
  const connectDevices =
    authAccessChanges.data?.type === "snapshot"
      ? (authAccessChanges.data.payload.connectDevices ?? null)
      : null;
  const updateAccessSettings = useUpdateEnvironmentSettings(accessEnvironmentId);
  const [pendingConnectRevoke, setPendingConnectRevoke] =
    useState<ConnectDeviceRevokeRequest | null>(null);
  // With approval off a revoked T3 Connect device signs straight back in, so offer to turn it
  // on. Older servers have no such setting, and revoking there goes ahead as before.
  const connectApprovalOff =
    accessEnvironment?.serverConfig?.settings.requireConnectDeviceApproval === false;
  const requestConnectRevoke = (title: string, revoke: () => Promise<void>) => {
    if (connectApprovalOff && canWriteAccess) setPendingConnectRevoke({ title, revoke });
    else void revoke();
  };
  const requireConnectApproval = () =>
    new Promise<boolean>((resolve) =>
      updateAccessSettings(
        { requireConnectDeviceApproval: true },
        { onSaved: () => resolve(true), onFailed: () => resolve(false) },
      ),
    );
  const revokeOtherClients = useAtomCommand(authEnvironment.revokeOtherClients, {
    reportFailure: false,
  });
  const [isRevokingOthers, setIsRevokingOthers] = useState(false);
  const otherClientSessions =
    authAccessChanges.data?.type === "snapshot"
      ? authAccessChanges.data.payload.clientSessions
          .filter((session) => !session.current)
          .map(toDesktopClientSessionRecord)
      : [];
  const revokeOthers = async () => {
    if (accessEnvironmentId === null) return;
    const warning = recentPeerLinkRevokeWarning(otherClientSessions);
    if (warning && !(await (requestConfirmDialog(warning, { variant: "destructive" }) ?? false))) {
      return;
    }
    setIsRevokingOthers(true);
    const result = await revokeOtherClients({ environmentId: accessEnvironmentId, input: null });
    setIsRevokingOthers(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: result.value === 1 ? "Signed out 1 other" : `Signed out ${result.value} others`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not sign out the others",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  // Signing everyone else out also ends T3 Connect devices, so it goes through the same
  // offer to turn on approval as revoking one of them.
  const requestRevokeOthers = () => {
    const endsConnectDevices =
      (connectDevices?.length ?? 0) > 0 ||
      otherClientSessions.some((session) => session.subject === "cloud-connect");
    if (endsConnectDevices) requestConnectRevoke("Sign out everyone else?", revokeOthers);
    else void revokeOthers();
  };
  const tailscaleHttpsEndpoint = desktopAdvertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null;
  const visibleDesktopNetworkAdvertisedEndpoints = isLocalBackendNetworkAccessible
    ? desktopAdvertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
    : [];
  const defaultDesktopNetworkAdvertisedEndpoint = selectPairingEndpoint(
    visibleDesktopNetworkAdvertisedEndpoints,
    defaultAdvertisedEndpointKey,
  );
  const defaultDesktopAdvertisedEndpoint =
    defaultDesktopNetworkAdvertisedEndpoint ??
    selectPairingEndpoint(
      tailscaleHttpsEndpoint ? [tailscaleHttpsEndpoint] : [],
      defaultAdvertisedEndpointKey,
    );
  const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
    : null;
  const handleSetDefaultAdvertisedEndpoint = (endpoint: AdvertisedEndpoint) => {
    setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
  };

  const renderEndpointRows = () =>
    isAdvertisedEndpointListExpanded
      ? visibleDesktopNetworkAdvertisedEndpoints.map((endpoint) => (
          <AdvertisedEndpointListRow
            key={endpoint.id}
            endpoint={endpoint}
            isDefault={
              endpointDefaultPreferenceKey(endpoint) === defaultDesktopAdvertisedEndpointKey
            }
            onSetDefault={handleSetDefaultAdvertisedEndpoint}
            onSetupTailscaleServe={handleStartTailscaleServeSetup}
            onDisableTailscaleServe={handleStartTailscaleServeDisable}
            isUpdatingTailscaleServe={isUpdatingTailscaleServe}
          />
        ))
      : null;
  const renderNetworkAccessToggle = () => (
    <Switch
      checked={desktopServerExposureState?.mode === "network-accessible"}
      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
      onCheckedChange={(checked) => {
        setPendingDesktopServerExposureMode(checked ? "network-accessible" : "local-only");
      }}
      aria-label="Allow remote devices"
    />
  );
  const renderTailscaleRow = () => (
    <SettingsRow
      {...searchableSetting("tailscale-https")}
      description="Publishes this computer at an HTTPS address that only devices on your tailnet can open."
      status={tailscaleServeDenial ? <ManagedNotice>{tailscaleServeDenial}</ManagedNotice> : null}
      control={
        tailscaleHttpsEndpoint ? (
          <Switch
            checked={tailscaleHttpsEndpoint.status === "available"}
            disabled={isUpdatingTailscaleServe}
            onCheckedChange={(checked) => {
              if (checked) {
                handleStartTailscaleServeSetup(tailscaleHttpsEndpoint);
                return;
              }
              handleStartTailscaleServeDisable(tailscaleHttpsEndpoint);
            }}
            aria-label="Enable Tailscale HTTPS"
          />
        ) : null
      }
      managed={tailscaleHttpsEndpoint?.status === "available" ? undefined : tailscaleServeDenial}
    >
      {tailscaleHttpsEndpoint?.status === "available" || !tailscaleServeDenial ? (
        <p className="mt-2 mb-2 text-xs text-muted-foreground break-words">
          {tailscaleHttpsEndpoint?.status === "available"
            ? tailscaleHttpsEndpoint.httpBaseUrl
            : missingTailscaleEndpointDescription(desktopServerExposureState)}
        </p>
      ) : null}
    </SettingsRow>
  );
  const renderNetworkAccessRow = () => (
    <SettingsRow
      {...searchableSetting("network-access")}
      description="Lets phones and computers on your network or tailnet reach this computer once you pair them. Off: only this computer can connect."
      status={remoteClientsDenial ? <ManagedNotice>{remoteClientsDenial}</ManagedNotice> : null}
      control={renderNetworkAccessToggle()}
      managed={isLocalBackendNetworkAccessible ? undefined : remoteClientsDenial}
    >
      {desktopServerExposureError ? (
        <p className="mt-2 mb-2 text-xs text-destructive">{desktopServerExposureError}</p>
      ) : !desktopServerExposureState ? (
        <p className="mt-2 mb-2 text-xs text-muted-foreground">Loading…</p>
      ) : isLocalBackendNetworkAccessible ? (
        <div className="mt-2 mb-2 text-xs text-muted-foreground">
          <NetworkAccessDescription
            endpoint={defaultDesktopNetworkAdvertisedEndpoint}
            hiddenEndpointCount={Math.max(visibleDesktopNetworkAdvertisedEndpoints.length - 1, 0)}
            expanded={isAdvertisedEndpointListExpanded}
            onToggleExpanded={() => setIsAdvertisedEndpointListExpanded((expanded) => !expanded)}
            fallback={`Reachable at ${desktopServerExposureState.endpointUrl ?? "this computer's network address"}`}
          />
          <p>Over plain HTTP. Use Tailscale or a VPN away from home.</p>
        </div>
      ) : null}
    </SettingsRow>
  );
  const renderDisabledNetworkAccessRow = () => (
    <SettingsRow
      {...searchableSetting("network-access")}
      description={
        desktopBridge
          ? "This connection cannot view or change network exposure."
          : "Change this where the server starts: t3 serve --lan or T3CODE_LAN. Phones and computers can connect only after pairing."
      }
      status={remoteClientsDenial ? <ManagedNotice>{remoteClientsDenial}</ManagedNotice> : null}
      control={
        <Switch
          checked={isLocalBackendNetworkAccessible}
          disabled
          aria-label="Allow remote devices"
        />
      }
    />
  );

  const accessServerConfig = accessEnvironment?.serverConfig ?? null;
  const accessEnvironmentLabel =
    accessEnvironment?.label ?? (desktopBridge ? "This machine" : "Primary environment");

  if (accessEnvironmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("connections-environment")}>
          <SettingsRow
            title="No environment selected"
            description="Connect an environment to view its privacy settings."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      {accessEnvironmentPicker}
      <SettingsSection
        {...searchableSetting("connections-environment")}
        title="Remote devices"
        icon={
          <EnvironmentMachineIcon
            aria-hidden
            kind={
              accessServerConfig ? resolveEnvironmentMachineKind(accessServerConfig) : "desktop"
            }
            className="size-4"
          />
        }
      >
        {accessServerConfig?.managedPolicy ? (
          <div className="px-3 py-2 sm:px-4">
            <ManagedByOrganization policy={accessServerConfig.managedPolicy} />
          </div>
        ) : null}
        {canManageLocalBackend && desktopBridge ? (
          <>
            {renderNetworkAccessRow()}
            {renderEndpointRows()}
            {renderTailscaleRow()}
          </>
        ) : (
          <>
            {!desktopBridge || isPrimaryAccess ? renderDisabledNetworkAccessRow() : null}
            <SettingsRow
              {...searchableSetting("tailscale-https")}
              description="Publishes an HTTPS address for devices on your tailnet. Configure Tailscale Serve on the host computer."
              status={
                remoteClientsDenial ? <ManagedNotice>{remoteClientsDenial}</ManagedNotice> : null
              }
            />
          </>
        )}
        {accessServerConfig ? (
          <TailnetPairingRow
            environmentId={accessEnvironmentId}
            environmentLabel={accessEnvironmentLabel}
            settings={accessServerConfig.settings.tailnetConnect}
            managed={managedCapabilityDenial(accessServerConfig.managedPolicy, "remoteClients")}
            privacy
            canWrite={canWriteAccess}
          />
        ) : null}
        <PrivacyDeviceRows />
        {canReadAccess && canWriteAccess ? (
          <SettingsRow
            title="Sign out everyone else"
            description="Ends every other device, app and link on this server. Each needs new access to come back."
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={isRevokingOthers || otherClientSessions.length === 0}
                onClick={requestRevokeOthers}
              >
                {isRevokingOthers ? "Signing out…" : "Sign out…"}
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      {hasCloudPublicConfig() ? (
        <SettingsSection title="T3 Connect relay">
          <CloudLinkRow
            privacy
            environmentId={accessEnvironmentId}
            canReadRelay={canReadRelay}
            canManageRelay={canManageRelay}
            connectDeviceApproval={
              accessServerConfig?.settings.requireConnectDeviceApproval === undefined
                ? null
                : {
                    required: accessServerConfig.settings.requireConnectDeviceApproval,
                    canManage: canWriteAccess,
                  }
            }
          />
          <CloudRemoteEnvironmentRows
            primaryEnvironmentId={primaryEnvironmentId}
            savedEnvironments={savedEnvironments}
          />
        </SettingsSection>
      ) : null}
      {canReadAccess &&
      connectDevices !== null &&
      (connectDeviceRequests.length > 0 || connectDevices.length > 0) ? (
        <ConnectDeviceApprovalSettings
          environmentId={accessEnvironmentId}
          requests={connectDeviceRequests}
          devices={connectDevices}
          canWrite={canWriteAccess}
          requestRevoke={requestConnectRevoke}
        />
      ) : null}
      <RevokeConnectDeviceDialog
        request={pendingConnectRevoke}
        onClose={() => setPendingConnectRevoke(null)}
        requireApproval={requireConnectApproval}
      />
      <PrivacySettings
        environmentId={accessEnvironmentId}
        networkAccessible={
          isLocalBackendNetworkAccessible || tailscaleHttpsEndpoint?.status === "available"
        }
      />
      <AlertDialog
        open={pendingDesktopServerExposureMode !== null && canManageLocalBackend}
        onOpenChange={(open) => {
          if (!open && !isUpdatingDesktopServerExposure) setPendingDesktopServerExposureMode(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDesktopServerExposureMode === "network-accessible"
                ? "Allow remote devices?"
                : "Stop allowing remote devices?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDesktopServerExposureMode === "network-accessible"
                ? `Let your other devices connect to ${APP_BASE_NAME} over the network. Pair devices to give them access. ${APP_BASE_NAME} will restart.`
                : `Devices connected over your local network will disconnect. Existing tunnels, such as T3 Connect or Tailscale HTTPS, keep working. ${APP_BASE_NAME} will restart.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isUpdatingDesktopServerExposure}
              render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
            >
              <span className="[text-box:trim-both_cap_alphabetic]">Cancel</span>
            </AlertDialogClose>
            <Button
              variant="default"
              onClick={handleConfirmDesktopServerExposureChange}
              disabled={
                !canManageLocalBackend ||
                pendingDesktopServerExposureMode === null ||
                isUpdatingDesktopServerExposure
              }
            >
              {isUpdatingDesktopServerExposure && <Spinner size="sm" />}
              <span className="[text-box:trim-both_cap_alphabetic]">
                {isUpdatingDesktopServerExposure
                  ? "Restarting…"
                  : pendingDesktopServerExposureMode === "network-accessible"
                    ? "Restart and enable"
                    : "Restart and disable"}
              </span>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={disableTailscaleServeDialogOpen && canManageLocalBackend}
        onOpenChange={(open) => {
          if (isUpdatingTailscaleServe) return;
          setDisableTailscaleServeDialogOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Tailscale HTTPS?</AlertDialogTitle>
            <AlertDialogDescription>
              {APP_BASE_NAME} will restart the local backend without Tailscale Serve.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isUpdatingTailscaleServe}
              render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmTailscaleServeDisable()}
              disabled={isUpdatingTailscaleServe || !canManageLocalBackend}
            >
              {isUpdatingTailscaleServe ? (
                <>
                  <Spinner size="sm" />
                  Restarting…
                </>
              ) : (
                "Restart and disable"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={pendingTailscaleServeEndpoint !== null}
        onOpenChange={(open) => {
          if (isUpdatingTailscaleServe) return;
          if (!open) setPendingTailscaleServeEndpoint(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set up Tailscale HTTPS?</DialogTitle>
            <DialogDescription>
              {APP_BASE_NAME} will restart the local backend with Tailscale Serve enabled and ask
              Tailscale to proxy HTTPS traffic to this backend.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="text-sm font-medium text-foreground">HTTPS port</span>
              <Input
                className="mt-2"
                type="number"
                inputMode="numeric"
                min={1}
                max={65_535}
                step={1}
                value={tailscaleServePortInput}
                onChange={(event) => setTailscaleServePortInput(event.target.value)}
                disabled={isUpdatingTailscaleServe}
              />
            </label>
            {!isTailscaleServePortValid ? (
              <p className="mt-2 text-xs text-destructive">Enter a port from 1 to 65535.</p>
            ) : null}
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <p className="text-xs font-medium text-muted-foreground">HTTPS endpoint</p>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <p className="mt-1 truncate text-sm text-foreground">
                      {pendingTailscaleServeBaseUrl ?? "Pending MagicDNS endpoint"}
                    </p>
                  }
                />
                {pendingTailscaleServeBaseUrl ? (
                  <TooltipPopup side="top">{pendingTailscaleServeBaseUrl}</TooltipPopup>
                ) : null}
              </Tooltip>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose
              disabled={isUpdatingTailscaleServe}
              render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
            >
              Cancel
            </DialogClose>
            <Button
              onClick={() => void handleConfirmTailscaleServeSetup()}
              disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
            >
              {isUpdatingTailscaleServe ? (
                <>
                  <Spinner size="sm" />
                  Restarting…
                </>
              ) : (
                "Enable"
              )}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
