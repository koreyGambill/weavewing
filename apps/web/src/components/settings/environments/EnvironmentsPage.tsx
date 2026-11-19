import { AuthEnvironmentMaintainScope, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { requestConfirmDialog } from "~/confirmDialog";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopNetworkAccessStateAtom } from "~/state/desktopNetworkAccess";
import { type EnvironmentPresentation, usePrimaryEnvironmentId } from "~/state/environments";
import { usePreferredEnvironmentId } from "~/state/preferredEnvironment";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { RemoveT3ConnectEnvironmentDialog } from "../../clerk/RemoveT3ConnectEnvironmentDialog";
import { Badge } from "../../ui/badge";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { AddEnvironmentDialog } from "../AddEnvironmentDialog";
import { LoadBalancingSettings } from "../LoadBalancingSettings";
import { LocalEnvironmentSetting } from "../LocalEnvironmentSetting";
import { PreferredEnvironmentSetting } from "../PreferredEnvironmentSetting";
import { PullRequestRoutingSettings } from "../PullRequestRoutingSettings";
import { SavedBackendListRow } from "../SavedEnvironmentRows";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { type ReachModel, type ReachParty, squareKey } from "./reachModel.logic";
import { AccessLine, ServerAccessDetail } from "./ServerAccessDetail";
import { LocalServerRow, ServerAccessMenuItems, ServerAccessToggle } from "./ServerRows";
import { ConnectWizard } from "./ConnectWizard";
import { ReachGrid } from "./ReachGrid";
import { type ReachServer, useReachModel } from "./useReachModel";
import { type SquareChangeState, useSquareChange } from "./useSquareChange";
import { WslBackendSettings } from "./WslBackendSettings";

/** Settings → Environments: the computers, servers and devices, and who may reach what. */
export function EnvironmentsPage() {
  const data = useReachModel();
  const change = useSquareChange();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preferredEnvironmentId = usePreferredEnvironmentId() ?? primaryEnvironmentId;
  const local = data.servers.filter((server) => server.input.onThisComputer);
  const others = data.servers.filter((server) => !server.input.onThisComputer);
  const balanced = data.servers
    .filter(
      (server) =>
        server.environment.entry.target._tag === "PrimaryConnectionTarget" ||
        server.environment.entry.enabled,
    )
    .map((server) => server.environment);

  return (
    <SettingsPageContainer>
      <ConnectWizard model={data.model} servers={data.servers} change={change} />
      {data.servers.length > 1 ? <TrustedTogether model={data.model} /> : null}
      {data.thisComputer !== null ? (
        <SettingsSection
          {...searchableSetting("connections-environment")}
          title={`This computer · ${data.thisComputer}`}
        >
          <OpenToRow />
          <LocalEnvironmentSetting />
          <ThisComputerWsl />
          {local.map((server) => (
            <LocalServerRow
              key={server.input.environmentId}
              model={data.model}
              server={server}
              change={change}
              isDefault={server.input.environmentId === preferredEnvironmentId}
            />
          ))}
        </SettingsSection>
      ) : null}
      <OtherServers
        model={data.model}
        servers={others}
        allServers={data.servers}
        change={change}
        title={data.thisComputer === null ? "Servers" : "Other servers running Weavewing"}
        preferredEnvironmentId={preferredEnvironmentId}
      />
      <Devices model={data.model} change={change} />
      <ReachGrid model={data.model} change={change} />
      <PreferredEnvironmentSetting />
      <LoadBalancingSettings environments={balanced} />
      <PullRequestRoutingSettings environments={balanced} />
    </SettingsPageContainer>
  );
}

/** The groups of servers with Full access to each other both ways; derived, never set. */
function TrustedTogether({ model }: { readonly model: ReachModel }) {
  return (
    <SettingsSection title="Trusted together">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
        {model.trusted.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No servers have Full access to each other both ways.
          </span>
        ) : (
          model.trusted.map((group) => (
            <span key={group.map((party) => party.id).join("+")} className="flex gap-1.5">
              {group.map((party) => (
                <Badge key={party.id} variant="success" size="lg">
                  {party.label}
                </Badge>
              ))}
            </span>
          ))
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          Full access to each other, both ways
        </span>
      </div>
    </SettingsSection>
  );
}

/**
 * How anything can connect in to this computer. The switches live under Privacy with their
 * restart confirmations, so each chip goes there.
 */
function OpenToRow() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const network = useEnvironmentQuery(
    canMaintain && !isLocalEnvironmentDisabled() ? desktopNetworkAccessStateAtom : null,
  );
  const exposure = network.data?.serverExposureState ?? null;
  const localNetwork = exposure?.mode === "network-accessible";
  const tailscale =
    exposure?.tailscaleServeEnabled === true ||
    (localNetwork &&
      (network.data?.advertisedEndpoints ?? []).some(
        (endpoint) => endpoint.provider.id === "tailscale" && endpoint.status === "available",
      ));
  const chips = [
    { label: "Tailscale", on: tailscale, hash: "tailscale-https" },
    { label: "Local network", on: localNetwork, hash: "network-access" },
  ];
  return (
    <SettingsRow
      title="Open to"
      control={
        <span className="flex flex-wrap justify-end gap-1.5">
          {exposure === null ? (
            <span className="text-xs text-muted-foreground">
              {network.error ?? (canMaintain ? "Loading…" : "Set in Privacy")}
            </span>
          ) : (
            chips.map((chip) => (
              <Badge
                key={chip.label}
                size="lg"
                variant={chip.on ? "success" : "outline"}
                render={<Link to="/settings/privacy" hash={chip.hash} />}
                aria-label={`${chip.label}: ${chip.on ? "on" : "off"}. Change in Privacy`}
              >
                {chip.label}
                {chip.on ? "" : " off"}
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </Badge>
            ))
          )}
        </span>
      }
    />
  );
}

function ThisComputerWsl() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  return (
    <WslBackendSettings canManageLocalBackend={canMaintain && !isLocalEnvironmentDisabled()} />
  );
}

function serverNote(server: ReachServer) {
  const { input } = server;
  if (input.route === "ssh" && input.reachableFromOthers === false) {
    return {
      text: "Only this app reaches it, over SSH. Nothing else has a path.",
      tone: "warning",
    } as const;
  }
  if (input.appScopes === null) return null;
  return input.canManage
    ? ({
        text: "You have full access, so you can manage who uses it from here.",
        tone: "success",
      } as const)
    : ({ text: `Who uses ${input.label} is set on ${input.label}.`, tone: "muted" } as const);
}

function OtherServerRow({
  model,
  server,
  change,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
  onAddRoute,
}: {
  readonly model: ReachModel;
  readonly server: ReachServer;
  readonly change: SquareChangeState;
  readonly removingEnvironmentId: EnvironmentId | null;
  readonly onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  readonly onRemove: (environment: EnvironmentPresentation) => void;
  readonly onAddRoute: (environment: EnvironmentPresentation) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SavedBackendListRow
      environment={server.environment}
      removingEnvironmentId={removingEnvironmentId}
      onSetEnabled={onSetEnabled}
      onRemove={onRemove}
      onAddRoute={onAddRoute}
      access={
        <ServerAccessToggle
          model={model}
          server={server}
          open={open}
          onOpenChange={setOpen}
          note={serverNote(server)}
        />
      }
      accessDetail={
        open ? <ServerAccessDetail model={model} server={server} change={change} /> : null
      }
      menuItems={<ServerAccessMenuItems server={server} />}
    />
  );
}

function OtherServers({
  model,
  servers,
  allServers,
  change,
  title,
  preferredEnvironmentId,
}: {
  readonly model: ReachModel;
  readonly servers: ReadonlyArray<ReachServer>;
  readonly allServers: ReadonlyArray<ReachServer>;
  readonly change: SquareChangeState;
  readonly title: string;
  readonly preferredEnvironmentId: EnvironmentId | null;
}) {
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [routeTarget, setRouteTarget] = useState<EnvironmentPresentation | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<EnvironmentId | null>(null);
  const [pendingT3ConnectRemoval, setPendingT3ConnectRemoval] =
    useState<EnvironmentPresentation | null>(null);
  const savedEnvironments = allServers
    .map((server) => server.environment)
    .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget");
  const fail = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  const setEnabled = async (environmentId: EnvironmentId, enabled: boolean) => {
    const result = await setEnvironmentEnabled({ environmentId, enabled });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      fail(`Could not switch it ${enabled ? "on" : "off"}`, result);
    }
  };
  const remove = async (environment: EnvironmentPresentation) => {
    setRemovingId(environment.environmentId);
    const result = await removeEnvironment(environment.environmentId);
    setRemovingId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      fail("Could not remove it", result);
    }
  };
  const requestRemove = async (environment: EnvironmentPresentation) => {
    if (environment.relayManaged && hasCloudPublicConfig()) {
      setPendingT3ConnectRemoval(environment);
      return;
    }
    const confirmed = await (requestConfirmDialog(
      `Remove ${environment.label} from this device?\nThis forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (confirmed) await remove(environment);
  };
  // The server that served this page comes first; on desktop it sits under This computer.
  const visible = servers
    .filter((server) => !isDesktopLocalConnectionTarget(server.environment.entry.target))
    .toSorted(
      (left, right) =>
        Number(right.environment.entry.target._tag === "PrimaryConnectionTarget") -
        Number(left.environment.entry.target._tag === "PrimaryConnectionTarget"),
    );
  return (
    <SettingsSection {...searchableSetting("remote-environments")} title={title}>
      {visible.length === 0 ? (
        <SettingsRow title="None yet" />
      ) : (
        visible.map((server) =>
          server.environment.entry.target._tag === "PrimaryConnectionTarget" ? (
            <LocalServerRow
              key={server.input.environmentId}
              model={model}
              server={server}
              change={change}
              isDefault={server.input.environmentId === preferredEnvironmentId}
            />
          ) : (
            <OtherServerRow
              key={server.input.environmentId}
              model={model}
              server={server}
              change={change}
              removingEnvironmentId={removingId}
              onSetEnabled={(environmentId, enabled) => void setEnabled(environmentId, enabled)}
              onRemove={(environment) => void requestRemove(environment)}
              onAddRoute={(environment) => {
                setRouteTarget(environment);
                setAddError(null);
                setAddOpen(true);
              }}
            />
          ),
        )
      )}
      <AddEnvironmentDialog
        open={addOpen}
        routeTarget={routeTarget}
        error={addError}
        savedEnvironments={savedEnvironments}
        showTrigger={false}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setAddError(null);
        }}
        onErrorChange={setAddError}
      />
      {hasCloudPublicConfig() ? (
        <RemoveT3ConnectEnvironmentDialog
          environmentLabel={pendingT3ConnectRemoval?.label ?? null}
          environmentId={pendingT3ConnectRemoval?.environmentId ?? null}
          onCancel={() => setPendingT3ConnectRemoval(null)}
          onConfirm={() => {
            if (!pendingT3ConnectRemoval) return;
            setPendingT3ConnectRemoval(null);
            void remove(pendingT3ConnectRemoval);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function usesText(model: ReachModel, party: ReachParty) {
  const used = model.columns.filter((column) => {
    const state = model.squares.get(squareKey(party.id, column.id))?.state;
    return state?.kind === "level";
  });
  return used.length === 0
    ? "Uses nothing here"
    : `Uses ${used.map((column) => column.label).join(", ")}`;
}

/** Phones, browsers, this app and outside agents: they connect in, nothing connects to them. */
function Devices({
  model,
  change,
}: {
  readonly model: ReachModel;
  readonly change: SquareChangeState;
}) {
  const devices = model.rows.filter((row) => row.kind !== "server");
  return (
    <SettingsSection title="Devices">
      {devices.map((device) => (
        <DeviceRow key={device.id} model={model} device={device} change={change} />
      ))}
    </SettingsSection>
  );
}

function DeviceRow({
  model,
  device,
  change,
}: {
  readonly model: ReachModel;
  readonly device: ReachParty;
  readonly change: SquareChangeState;
}) {
  const [open, setOpen] = useState(false);
  const squares = model.columns.flatMap((column) => {
    const square = model.squares.get(squareKey(device.id, column.id));
    return square?.state.kind === "level" ? [square] : [];
  });
  return (
    <div className="px-3 py-2.5 sm:px-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {device.label}
          {device.kind === "agent" ? (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">agent</span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{usesText(model, device)}</span>
      </button>
      {open ? (
        <div className="mt-2 space-y-1 rounded-lg bg-muted/40 px-3 py-2 sm:px-4">
          {squares.map((square) => (
            <AccessLine key={square.to.id} square={square} name={square.to.label} change={change} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
