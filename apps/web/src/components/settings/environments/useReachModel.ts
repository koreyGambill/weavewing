import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  type AuthAccessSnapshot,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { desktopLocalBackendId, isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useDesktopLocalBootstraps } from "~/connection/useDesktopLocalBootstraps";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { authEnvironment } from "~/state/auth";
import { desktopNetworkAccessStateAtom } from "~/state/desktopNetworkAccess";
import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { environmentSessionStatesAtom, useEnvironmentsWithScope } from "~/state/session";
import { isServerNetworkAccessible } from "../ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "../settingsScopeAxis";
import { buildReachModel, type ReachModel, type ReachServerInput } from "./reachModel.logic";

// The same atom keys as every other reader, so each server keeps one access stream.
const accessAtom = (environmentId: EnvironmentId) =>
  authEnvironment.accessChanges({ environmentId, input: null });
const accessListAtom = environmentAtomList("web-environments-access", accessAtom);
const linksAtom = (environmentId: EnvironmentId) =>
  peerLinkEnvironment.list({ environmentId, input: {} });
const linksListAtom = environmentAtomList("web-environments-links", linksAtom);

export interface ReachServer {
  readonly environment: EnvironmentPresentation;
  readonly input: ReachServerInput;
  /** Pending pairing links and sessions, when this app may read them. */
  readonly access: AuthAccessSnapshot | null;
  readonly accessError: string | null;
  readonly linksError: string | null;
}

export interface ReachData {
  readonly model: ReachModel;
  readonly servers: ReadonlyArray<ReachServer>;
  /** Set on desktop: the name of the computer this app and its own servers run on. */
  readonly thisComputer: string | null;
  readonly loading: boolean;
}

// On the web the serving server may be another machine, so only the desktop's own count as local.
const routeOf = (
  environment: EnvironmentPresentation,
  isDesktop: boolean,
): ReachServerInput["route"] => {
  const target = environment.entry.target;
  if (isDesktopLocalConnectionTarget(target)) return "local";
  if (target._tag === "PrimaryConnectionTarget") return isDesktop ? "local" : "direct";
  if (target._tag === "SshConnectionTarget") return "ssh";
  return target._tag === "RelayConnectionTarget" ? "relay" : "direct";
};

/** Everything the page shows about who reaches which server, from what this app may read. */
export function useReachModel(): ReachData {
  const registry = useContext(RegistryContext);
  const { environments, isReady } = useEnvironments();
  const bootstraps = useDesktopLocalBootstraps();
  const isDesktop = window.desktopBridge !== undefined;
  const listed = environments.filter(
    (environment) => environment.connection.phase !== "unsupported",
  );
  const readable = useEnvironmentsWithScope(listed, AuthAccessReadScope);
  const manageable = useEnvironmentsWithScope(listed, AuthAccessWriteScope);
  const sessionStates = useAtomValue(
    environmentSessionStatesAtom(environmentIdsKey(listed.map((entry) => entry.environmentId))),
  );
  const readableIds = listed
    .filter((environment) => readable.has(environment.environmentId))
    .map((environment) => environment.environmentId);
  const linkIds = listed
    .filter(
      (environment) =>
        readable.has(environment.environmentId) &&
        offersLinkedEnvironments(environment.serverConfig),
    )
    .map((environment) => environment.environmentId);
  const accessResults = useAtomValue(accessListAtom(environmentIdsKey(readableIds)));
  const linkResults = useAtomValue(linksListAtom(environmentIdsKey(linkIds)));
  const primary = listed.find((entry) => entry.entry.target._tag === "PrimaryConnectionTarget");
  const primaryManaged = primary !== undefined && manageable.has(primary.environmentId);
  const networkAccess = useEnvironmentQuery(
    isDesktop && primaryManaged ? desktopNetworkAccessStateAtom : null,
  );

  // Listing links asks every linked server whether it answers, so read again only on return.
  useLiveRefresh(
    () => {
      for (const environmentId of linkIds) registry.refresh(linksAtom(environmentId));
    },
    { key: "environments-page-links", intervalMs: null, refreshOnShow: true },
  );

  const sharing = new Set(
    bootstraps.flatMap((bootstrap) =>
      bootstrap.sharesHostLoopback === true ? [bootstrap.id] : [],
    ),
  );
  const servers = listed.map((environment, index): ReachServer => {
    const { environmentId, entry, serverConfig } = environment;
    const target = entry.target;
    const isPrimary = target._tag === "PrimaryConnectionTarget";
    const desktopLocal = isDesktopLocalConnectionTarget(target);
    const session = AsyncResult.getOrElse(sessionStates[index]!, () => null);
    const authenticated =
      session?.authenticated === true && environment.connection.phase === "connected";
    const accessIndex = readableIds.indexOf(environmentId);
    const accessResult = accessIndex === -1 ? null : accessResults[accessIndex]!;
    const linkIndex = linkIds.indexOf(environmentId);
    const linkResult = linkIndex === -1 ? null : linkResults[linkIndex]!;
    const exposure = isPrimary ? networkAccess.data?.serverExposureState : undefined;
    const reachableFromOthers =
      exposure !== undefined
        ? exposure.mode === "network-accessible" || exposure.tailscaleServeEnabled
        : serverConfig === null || session === null
          ? null
          : isServerNetworkAccessible({
              authPolicy: session.auth.policy,
              directEndpoints: serverConfig.directEndpoints,
            });
    const servedByTailscale =
      exposure?.tailscaleServeEnabled ??
      (serverConfig?.directEndpoints ?? []).some(
        (endpoint) => endpoint.kind === "tailnet" && endpoint.httpBaseUrl.startsWith("https:"),
      );
    const accessEvent =
      accessResult === null ? null : AsyncResult.getOrElse(accessResult, () => null);
    const access = accessEvent?.type === "snapshot" ? accessEvent.payload : null;
    const links = linkResult === null ? null : AsyncResult.getOrElse(linkResult, () => null);
    const errorOf = (result: AsyncResult.AsyncResult<unknown, unknown> | null) =>
      result?._tag === "Failure" ? "Could not load" : null;
    return {
      environment,
      access,
      accessError: errorOf(accessResult),
      linksError: errorOf(linkResult),
      input: {
        environmentId,
        label: settingsScopeEnvironmentLabel(environment, listed),
        onThisComputer: isDesktop && (isPrimary || desktopLocal),
        sharesHostLoopback:
          isDesktop &&
          (isPrimary || (desktopLocal && sharing.has(desktopLocalBackendId(target) ?? ""))),
        route: routeOf(environment, isDesktop),
        routeUrl:
          environment.displayUrl ?? (isPrimary && !isDesktop ? window.location.origin : null),
        reachableFromOthers,
        servedByTailscale,
        linksOffered: offersLinkedEnvironments(serverConfig),
        canManage: manageable.has(environmentId),
        appScopes: authenticated ? (session.permissions ?? session.scopes ?? []) : null,
        sessions: access?.clientSessions ?? null,
        links: links?.links ?? null,
      },
    };
  });
  const thisComputer = isDesktop
    ? (primary?.serverConfig?.hostname ?? primary?.label ?? "This computer")
    : null;
  return {
    model: buildReachModel({ servers: servers.map((server) => server.input) }),
    servers,
    thisComputer,
    loading:
      !isReady ||
      accessResults.some((result) => result._tag === "Initial") ||
      linkResults.some((result) => result._tag === "Initial"),
  };
}
