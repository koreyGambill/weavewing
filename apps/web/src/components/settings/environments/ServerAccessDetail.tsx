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
  incomingSquares,
  LINK_LEVEL_CHOICES,
  REACH_LEVEL_LABELS,
  type ReachModel,
  type ReachSquare,
} from "./reachModel.logic";
import type { ReachServer } from "./useReachModel";
import type { SquareChangeState } from "./useSquareChange";

const EMPTY_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];
const EMPTY_CREDENTIALS: ReadonlyMap<string, string> = new Map();

/** "4 come in · goes out to 2", or where that is managed when this app cannot read it. */
export function accessSummary(model: ReachModel, server: ReachServer): string {
  const column = model.columns.find((party) => party.environmentId === server.input.environmentId)!;
  const incoming = server.input.sessions === null ? null : incomingSquares(model, column).length;
  const outgoing =
    server.input.links === null
      ? null
      : (model.outgoing.get(server.input.environmentId)?.length ?? 0);
  return [
    incoming === null ? null : `${incoming} come in`,
    outgoing === null ? null : `goes out to ${outgoing}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function levelText(square: ReachSquare) {
  const { state } = square;
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
          <ArrivalTag arrival={square.arrivedVia} />
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
              <SelectValue>{levelText(square)}</SelectValue>
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
          <span className="w-44 text-xs text-muted-foreground">{levelText(square)}</span>
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

function Caption({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <p className="mt-2 mb-0.5 text-xs font-semibold first:mt-0">
      {title} <span className="font-normal text-muted-foreground">· {detail}</span>
    </p>
  );
}

/** A server's lines: what may come in, what it reaches elsewhere, and its history import. */
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
  const incoming = incomingSquares(model, column);
  const outgoing = model.outgoing.get(input.environmentId) ?? [];
  return (
    <div className="mt-2 space-y-1 rounded-lg bg-muted/40 px-3 py-2 sm:px-4">
      <Caption
        title="Coming in"
        detail={
          input.appScopes === null
            ? `last known, ${input.label} is not answering`
            : input.canManage
              ? `what others may do on ${input.label}`
              : `set on ${input.label}`
        }
      />
      {input.sessions === null ? (
        <p className="text-xs text-muted-foreground">
          {server.accessError ?? `This app cannot read who uses ${input.label}.`}
        </p>
      ) : (
        <>
          {incoming.map((square) => (
            <AccessLine
              key={square.from.id}
              square={square}
              name={square.from.label}
              change={change}
            />
          ))}
          <WaitingLinks server={server} />
        </>
      )}
      <Caption title="Going out" detail={`what ${input.label} may do elsewhere`} />
      {input.links === null ? (
        <p className="text-xs text-muted-foreground">
          {server.linksError ??
            (input.linksOffered
              ? `This app cannot read ${input.label}'s links.`
              : "Linked environments is off here (Settings → Labs).")}
        </p>
      ) : outgoing.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing</p>
      ) : (
        outgoing.map(({ target, square }) => (
          <AccessLine key={target.id} square={square} name={target.label} change={change} />
        ))
      )}
      {input.appScopes !== null ? (
        <div className="mt-2 border-t border-border/60 pt-1">
          <ImportConversations environmentId={input.environmentId} />
        </div>
      ) : null}
    </div>
  );
}
