import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { useState } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { authEnvironment } from "~/state/auth";
import { desktopNetworkAccessStateAtom } from "~/state/desktopNetworkAccess";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUiStateStore } from "~/uiStateStore";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { PairingClientsList } from "../AuthorizedClientsSettings";
import {
  isTailscaleHttpsEndpoint,
  serverPairingEndpoints,
  sortDesktopPairingLinks,
  toDesktopPairingLinkRecord,
} from "../ConnectionsSettings.logic";
import { ImportConversations } from "./ImportConversations";
import { ArrivalTag, SquareChangeStatus } from "./LevelControls";
import {
  accessHolders,
  LINK_LEVEL_CHOICES,
  REACH_LEVEL_LABELS,
  type ReachModel,
  type ReachSquare,
  squareKey,
} from "./reachModel.logic";
import type { ReachServer } from "./useReachModel";
import type { SquareChangeState } from "./useSquareChange";

const EMPTY_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];
const EMPTY_CREDENTIALS: ReadonlyMap<string, string> = new Map();

/** "3 have access", or nothing when this app cannot read who uses the server. */
export function accessSummary(model: ReachModel, server: ReachServer): string {
  if (server.input.sessions === null) return "";
  const column = model.columns.find((party) => party.environmentId === server.input.environmentId)!;
  const count = accessHolders(model, column).length;
  return count === 1 ? "1 has access" : `${count} have access`;
}

function levelText(square: ReachSquare, change: SquareChangeState) {
  const { state } = square;
  if (change.uncertain.has(squareKey(square.from.id, square.to.id))) return "Uncertain";
  if (state.kind !== "level") return "";
  const broken =
    state.broken === "expired" ? " · expired" : state.broken === "unauthorized" ? " · refused" : "";
  return `${REACH_LEVEL_LABELS[state.level]}${broken}`;
}

export function AccessLine({
  square,
  name,
  change,
}: {
  readonly square: ReachSquare;
  readonly name: string;
  readonly change: SquareChangeState;
}) {
  const { changes, state } = square;
  const level = state.kind === "level" ? state.level : null;
  const choice = LINK_LEVEL_CHOICES.find((candidate) => candidate === level) ?? null;
  const busy = change.busyKey !== null;
  return (
    <div className="py-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex min-w-28 flex-1 items-center gap-1.5">
          <span className="truncate">{name}</span>
          <ArrivalTag square={square} />
        </span>
        {changes.canRelink && (choice !== null || level === null) ? (
          <Select
            value={choice ?? ""}
            onValueChange={(next) => {
              const picked = LINK_LEVEL_CHOICES.find((option) => option === next);
              if (picked !== undefined) change.request(square, picked);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-44"
              aria-label={`Level for ${name}`}
              disabled={busy}
            >
              <SelectValue>{levelText(square, change)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {LINK_LEVEL_CHOICES.map((option) => (
                <SelectItem hideIndicator key={option} value={option}>
                  {REACH_LEVEL_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="w-44 text-xs text-muted-foreground">{levelText(square, change)}</span>
        )}
        <span className="flex w-20 justify-end">
          {changes.canRemove ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => change.request(square, "none")}
            >
              {changes.ownOutbound ? "Give up…" : "Remove"}
            </Button>
          ) : null}
        </span>
      </div>
      <SquareChangeStatus change={change} square={square} />
    </div>
  );
}

export function usePairingEndpoints(server: ReachServer): ReadonlyArray<AdvertisedEndpoint> {
  const target = server.environment.entry.target;
  const isPrimaryDesktop =
    window.desktopBridge !== undefined &&
    target._tag === "PrimaryConnectionTarget" &&
    server.input.canManage;
  const network = useEnvironmentQuery(isPrimaryDesktop ? desktopNetworkAccessStateAtom : null);
  if (!isPrimaryDesktop) {
    return serverPairingEndpoints(
      server.environment.serverConfig?.directEndpoints ?? [],
      isDesktopLocalConnectionTarget(target),
    );
  }
  const endpoints = network.data?.advertisedEndpoints ?? EMPTY_ENDPOINTS;
  const tailscaleHttps = endpoints.find(isTailscaleHttpsEndpoint);
  const networkEndpoints =
    network.data?.serverExposureState.mode === "network-accessible"
      ? endpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
      : [];
  return tailscaleHttps ? [...networkEndpoints, tailscaleHttps] : networkEndpoints;
}

/** Pairing links handed out from this server and not used yet. */
function WaitingLinks({ server }: { readonly server: ReachServer }) {
  const revokePairingLink = useAtomCommand(authEnvironment.revokePairingLink, {
    reportFailure: false,
  });
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const endpoints = usePairingEndpoints(server);
  const defaultEndpointKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  // T3 Connect devices waiting for approval are listed with T3 Connect, under Privacy.
  const links = sortDesktopPairingLinks(
    (server.access?.pairingLinks ?? [])
      .filter((link) => link.connectDeviceRequest === undefined)
      .map(toDesktopPairingLinkRecord),
  );
  if (links.length === 0) return null;
  const revoke = async (id: string) => {
    setRevokingId(id);
    const result = await revokePairingLink({
      environmentId: server.input.environmentId,
      input: { id },
    });
    setRevokingId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke pairing link",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return (
    <div className="-mx-3 rounded-lg border border-border/60 sm:-mx-4">
      <PairingClientsList
        servedByEnvironment={server.environment.entry.target._tag === "PrimaryConnectionTarget"}
        endpointUrl={null}
        endpoints={endpoints}
        defaultEndpointKey={defaultEndpointKey}
        pairingLinks={links}
        createdPairingCredentials={EMPTY_CREDENTIALS}
        sharedPairingLinkId={null}
        revokingPairingLinkId={revokingId}
        onRevokePairingLink={(id) => void revoke(id)}
        canRevoke={server.input.canManage && server.input.appScopes !== null}
      />
    </div>
  );
}

/** A server's list of who has access to it, and its history import. */
export function ServerAccessDetail({
  model,
  server,
  change,
}: {
  readonly model: ReachModel;
  readonly server: ReachServer;
  readonly change: SquareChangeState;
}) {
  const { input } = server;
  const column = model.columns.find((party) => party.environmentId === input.environmentId)!;
  const holders = accessHolders(model, column);
  const note =
    input.appScopes === null
      ? "Last known. It is not answering."
      : input.canManage
        ? null
        : `Set on ${input.label}.`;
  return (
    <div className="mt-2 space-y-1 rounded-lg bg-muted/40 px-3 py-2 sm:px-4">
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {input.sessions === null ? (
        <p className="text-xs text-muted-foreground">
          {server.accessError ?? `This app cannot read who uses ${input.label}.`}
        </p>
      ) : (
        <>
          {holders.length === 0 ? (
            <p className="text-xs text-muted-foreground">No one else has access.</p>
          ) : (
            holders.map((square) => (
              <AccessLine
                key={square.from.id}
                square={square}
                name={square.from.label}
                change={change}
              />
            ))
          )}
          <WaitingLinks server={server} />
        </>
      )}
      {input.appScopes !== null ? (
        <div className="mt-2 border-t border-border/60 pt-1">
          <ImportConversations environmentId={input.environmentId} />
        </div>
      ) : null}
    </div>
  );
}
