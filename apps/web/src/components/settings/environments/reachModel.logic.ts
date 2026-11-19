import {
  AuthAccessWriteScope,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  MCP_PEER_LINK_SUBJECT_PREFIX,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatRelativeElapsed } from "~/timestampFormat";

/** A server this app knows, with what this app can read and change there. */
export interface ReachServerInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Runs on the computer this app runs on: the desktop's own servers. */
  readonly onThisComputer: boolean;
  /** Its loopback is this computer's, so servers here reach it at 127.0.0.1. */
  readonly sharesHostLoopback: boolean;
  /** How this app reaches it. */
  readonly route: "local" | "ssh" | "relay" | "direct";
  /** The address this app uses, to tell how it arrived. */
  readonly routeUrl: string | null;
  /** Other machines have an address for it. Null while unknown. */
  readonly reachableFromOthers: boolean | null;
  /** Published through Tailscale Serve, whose local proxy makes tailnet clients look like 127.0.0.1. */
  readonly servedByTailscale: boolean;
  /** Linked environments is on, so its agents may link to other servers. */
  readonly linksOffered: boolean;
  readonly canManage: boolean;
  /** This app's own permissions there; null when not connected. */
  readonly appScopes: ReadonlyArray<AuthEnvironmentScope> | null;
  /** Who holds a session there; null when this app cannot read it or it has not loaded. */
  readonly sessions: ReadonlyArray<AuthClientSession> | null;
  /** Its outbound links; null when this app cannot read them or they have not loaded. */
  readonly links: ReadonlyArray<PeerLinkSummary> | null;
}

export type ReachLevel =
  | AuthMcpClientAccess
  /** A link's level read from the receiving side, which only knows it may change things. */
  | "can-change"
  /** A device paired with a hand-picked set of permissions. */
  | "custom";

export const REACH_LEVEL_LABELS: Record<ReachLevel, string> = {
  "read-only": "View only",
  "approval-required": "Ask before changes",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
  "can-change": "Can make changes",
  custom: "Custom",
};

/** The levels a link may be set to from this page. */
export const LINK_LEVEL_CHOICES = ["read-only", "approval-required", "full-access"] as const;
export type LinkLevelChoice = (typeof LINK_LEVEL_CHOICES)[number];

const LEVEL_RANK: Record<ReachLevel, number> = {
  "read-only": 1,
  custom: 2,
  "approval-required": 2,
  "can-change": 2,
  "auto-accept-edits": 3,
  auto: 4,
  "full-access": 5,
};

/** Whether moving from `current` to `next` gives more access, which needs the plain preview. */
export function isRaise(current: ReachLevel | null, next: ReachLevel): boolean {
  return current === null || LEVEL_RANK[next] > LEVEL_RANK[current];
}

export type Arrival = "same-computer" | "tailscale" | "local-network" | "internet" | "ssh";

export const ARRIVAL_LABELS: Record<Arrival, string> = {
  "same-computer": "same computer",
  tailscale: "via Tailscale",
  "local-network": "via local network",
  internet: "via the internet",
  ssh: "via SSH",
};

export type PartyKind = "server" | "app" | "device" | "agent";

export interface ReachParty {
  readonly id: string;
  readonly kind: PartyKind;
  readonly label: string;
  /** Set for a server, including one known only because it links in. */
  readonly environmentId: EnvironmentId | null;
  readonly onThisComputer: boolean;
}

export type SquareState =
  | { readonly kind: "self" }
  | {
      readonly kind: "level";
      readonly level: ReachLevel;
      /** Expired or refused: the link exists but cannot be used until it is renewed. */
      readonly broken: "expired" | "unauthorized" | null;
    }
  | { readonly kind: "none" }
  | { readonly kind: "no-path" }
  | { readonly kind: "unknown"; readonly reason: string };

/** What this app may do to one square, and why not when it may not. */
export interface SquareChanges {
  /** Set when this app cannot manage the receiving server. */
  readonly lockedReason: string | null;
  /** Removing ends the sessions here and forgets the link on the linking side when allowed. */
  readonly canRemove: boolean;
  /** Setting a link level relinks from the linking side with a code from the receiving one. */
  readonly canRelink: boolean;
  readonly relinkBlockedReason: string | null;
  /** The access is held by this app or one of this computer's servers on another machine. */
  readonly ownOutbound: boolean;
}

export interface ReachSquare {
  readonly from: ReachParty;
  readonly to: ReachParty;
  readonly state: SquareState;
  readonly arrivedVia: Arrival | null;
  /** The address or IP the arrival was read from, to show why. */
  readonly arrivedFrom: string | null;
  /** Sessions on the receiving server that make up this square, for removal. */
  readonly sessionIds: ReadonlyArray<AuthClientSession["sessionId"]>;
  /** The linking side's record, when it could be read. */
  readonly link: PeerLinkSummary | null;
  readonly changes: SquareChanges;
}

export interface ReachModel {
  readonly columns: ReadonlyArray<ReachParty>;
  readonly rows: ReadonlyArray<ReachParty>;
  readonly squares: ReadonlyMap<string, ReachSquare>;
  /** Groups of servers with Full access to each other in both directions. */
  readonly trusted: ReadonlyArray<ReadonlyArray<ReachParty>>;
  /** Columns whose access this app may change; the rest show a lock. */
  readonly manageable: ReadonlySet<string>;
  /** Columns for servers this app is not connected to, known only as a server's link target. */
  readonly unconnected: ReadonlySet<string>;
  /** The one session behind each device or agent row. */
  readonly deviceSessions: ReadonlyMap<string, AuthClientSession>;
}

export const APP_PARTY_ID = "app";
export const serverPartyId = (environmentId: EnvironmentId) => `server:${environmentId}`;
export const squareKey = (fromId: string, toId: string) => `${fromId}>${toId}`;

const T3_CONNECT_SESSION_SUBJECT = "cloud-connect";

const LINK_LABEL_PREFIX = /^(Linked environment|T3 Code) · /;

// oxlint-disable-next-line t3code/no-rpc-permission-bypass -- This client is auth metadata, not an RPC transport.
const clientOf = (session: AuthClientSession) => session.client;

function grants(session: AuthClientSession, scope: AuthEnvironmentScope): boolean {
  return (session.permissions ?? session.scopes).includes(scope);
}

/** The level a link session holds, which its scopes only tell apart at the ends. */
function linkSessionLevel(session: AuthClientSession): ReachLevel {
  if (!grants(session, AuthOrchestrationOperateScope)) return "read-only";
  return grants(session, AuthSettingsWriteScope) ? "full-access" : "can-change";
}

/** Full access manages who else has access; anything short of it is hand-picked. */
function deviceLevel(scopes: ReadonlyArray<AuthEnvironmentScope>): ReachLevel {
  if (!scopes.includes(AuthOrchestrationOperateScope)) return "read-only";
  return scopes.includes(AuthAccessWriteScope) ? "full-access" : "custom";
}

function isLinkSession(session: AuthClientSession): boolean {
  return (
    session.subject.startsWith(MCP_PEER_LINK_SUBJECT_PREFIX) ||
    (session.subject === "mcp-client" && LINK_LABEL_PREFIX.test(clientOf(session).label ?? ""))
  );
}

function linkSessionLabel(session: AuthClientSession): string {
  return (clientOf(session).label ?? "Linked environment").replace(LINK_LABEL_PREFIX, "");
}

/** The machine a link session belongs to: its id when the server recorded it. */
function linkSessionEnvironmentId(session: AuthClientSession): EnvironmentId | null {
  return session.subject.startsWith(MCP_PEER_LINK_SUBJECT_PREFIX)
    ? (session.subject.slice(MCP_PEER_LINK_SUBJECT_PREFIX.length) as EnvironmentId)
    : null;
}

function deviceName(session: AuthClientSession): string {
  const client = clientOf(session);
  if (client.label) return client.label;
  const parts = [client.browser, client.os].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" on ") : "Unnamed device";
}

// The label tailnet pairing gives the credential it issues, which the session keeps.
const TAILNET_PAIRING_LABEL = /^Tailnet: /;

const admittedOverTailnet = (session: AuthClientSession) =>
  TAILNET_PAIRING_LABEL.test(clientOf(session).label ?? "");

const ADMISSIONS: Record<string, string> = {
  "one-time-token": "paired by link or code",
  "administrative-bootstrap": "paired with the server's startup link",
  "desktop-bootstrap": "a desktop app on that computer",
  "cli-issued-session": "issued from the command line",
  "mcp-client": "outside agent, approved there",
};

function deviceKind(client: AuthClientSession["client"]): string | null {
  const { os, deviceType, browser } = client;
  if (os === "iOS") return deviceType === "tablet" ? "iPad" : "iPhone";
  if (deviceType === "mobile") return os ? `${os} phone` : "phone";
  if (deviceType === "tablet") return os ? `${os} tablet` : "tablet";
  const app = browser === "Electron" ? "desktop app" : browser;
  return [app, os].filter((part): part is string => Boolean(part)).join(" on ") || null;
}

/**
 * How a device got in, what it is and when it was last seen, so two entries that may be the
 * same phone each explain themselves. Without a stable device identity they are never merged.
 */
export function describeDevice(session: AuthClientSession, nowMs: number): string {
  const client = clientOf(session);
  const admission = admittedOverTailnet(session)
    ? "admitted automatically over Tailscale"
    : (ADMISSIONS[session.subject] ?? null);
  const kind = deviceKind(client);
  const seen = session.connected
    ? "connected now"
    : session.lastConnectedAt === null
      ? "never connected"
      : `last seen ${relativeLabel(nowMs - DateTime.toEpochMillis(session.lastConnectedAt))}`;
  return [admission, kind === deviceName(session) ? null : kind, seen]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function relativeLabel(elapsedMs: number): string {
  const { value, suffix } = formatRelativeElapsed(Math.max(0, elapsedMs));
  return suffix ? `${value} ${suffix}` : value;
}

function hostOf(address: string): string | null {
  try {
    return new URL(address.includes("://") ? address : `http://${address}`).hostname.replace(
      /^\[|\]$/g,
      "",
    );
  } catch {
    return null;
  }
}

/** How something at this host arrived, from the address alone. */
export function arrivalFromHost(host: string | null): Arrival | null {
  if (host === null || host.length === 0) return null;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower.startsWith("127.")) return "same-computer";
  if (lower.endsWith(".ts.net")) return "tailscale";
  const octets = lower.split(".").map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
    const [a, b] = octets as [number, number, number, number];
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return "local-network";
    }
    return "internet";
  }
  if (lower.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(lower)) return "local-network";
  if (lower.startsWith("fd7a:115c:a1e0:")) return "tailscale";
  return lower.includes(":") ? "internet" : null;
}

/**
 * How a session on `server` arrived. A loopback address proves nothing behind a local proxy
 * such as Tailscale Serve, so only a neighbour this app knows shares the computer counts as one.
 */
function sessionArrival(
  session: AuthClientSession,
  server: ReachServerInput,
  knownSameComputer: boolean,
): Pick<ReachSquare, "arrivedVia" | "arrivedFrom"> {
  const address = clientOf(session).ipAddress ?? null;
  const arrival = arrivalFromHost(address);
  if (arrival !== "same-computer" || knownSameComputer) {
    return { arrivedVia: arrival, arrivedFrom: address };
  }
  if (admittedOverTailnet(session)) {
    return { arrivedVia: "tailscale", arrivedFrom: "Admitted by tailnet pairing" };
  }
  return server.servedByTailscale
    ? { arrivedVia: "tailscale", arrivedFrom: `Through Tailscale Serve on ${server.label}` }
    : { arrivedVia: null, arrivedFrom: null };
}

const linkBroken = (link: PeerLinkSummary) =>
  link.status === "expired" || link.status === "unauthorized" ? link.status : null;

const arrivalFromUrl = (url: string | undefined) =>
  url === undefined ? null : arrivalFromHost(hostOf(url));

/** This app changes a server's access only while connected to it with full access there. */
const manages = (server: ReachServerInput | undefined): server is ReachServerInput =>
  server !== undefined && server.canManage && server.appScopes !== null;

const lockedReason = (to: ReachParty, server: ReachServerInput | undefined) =>
  server !== undefined && server.appScopes === null
    ? `${to.label} is not answering`
    : manages(server)
      ? null
      : `Set on ${to.label}`;

interface BuildContext {
  readonly byId: ReadonlyMap<EnvironmentId, ReachServerInput>;
}

function noPathBetween(
  from: ReachServerInput | null,
  to: ReachServerInput,
  fromOnThisComputer: boolean,
): boolean {
  if (to.reachableFromOthers !== false) return false;
  // A server here reaches another one here at 127.0.0.1 when both share this computer's loopback.
  const sharesLoopback =
    fromOnThisComputer &&
    to.onThisComputer &&
    to.sharesHostLoopback &&
    (from === null || from.sharesHostLoopback);
  return !sharesLoopback;
}

function serverSquare(
  context: BuildContext,
  from: ReachParty,
  to: ReachParty,
  sessionsFrom: ReadonlyArray<AuthClientSession>,
): ReachSquare {
  const fromServer = from.environmentId === null ? undefined : context.byId.get(from.environmentId);
  const toServer = context.byId.get(to.environmentId!)!;
  const link =
    fromServer?.links?.find((candidate) => candidate.environmentId === to.environmentId) ?? null;
  const ownOutbound = from.onThisComputer && !to.onThisComputer;
  const relinkBlockedReason = !manages(toServer)
    ? lockedReason(to, toServer)
    : fromServer === undefined || fromServer.appScopes === null
      ? `This app does not reach ${from.label}`
      : !fromServer.canManage
        ? `Changing the level needs this app to manage ${from.label} too`
        : !fromServer.linksOffered || !toServer.linksOffered
          ? "Linked environments is off on one of them (Settings → Labs)"
          : null;
  const base = {
    from,
    to,
    link,
    sessionIds: sessionsFrom.map((session) => session.sessionId),
  };
  const changes = (hasAccess: boolean): SquareChanges => ({
    lockedReason: lockedReason(to, toServer),
    canRemove:
      hasAccess &&
      ((manages(toServer) && sessionsFrom.length > 0) || (link !== null && manages(fromServer))),
    canRelink: relinkBlockedReason === null,
    relinkBlockedReason,
    ownOutbound,
  });

  if (link !== null) {
    return {
      ...base,
      state: {
        kind: "level",
        level: link.access,
        broken: linkBroken(link),
      },
      arrivedVia: arrivalFromUrl(link.urls[0]),
      arrivedFrom: link.urls[0] ?? null,
      changes: changes(true),
    };
  }
  const linkSession = sessionsFrom[0];
  // The linking side's list is the record of what it holds; a session it forgot grants nothing.
  if (fromServer?.links == null && linkSession !== undefined) {
    return {
      ...base,
      state: { kind: "level", level: linkSessionLevel(linkSession), broken: null },
      // Two servers of this desktop share its loopback; any other loopback address is a proxy.
      ...sessionArrival(linkSession, toServer, from.onThisComputer && to.onThisComputer),
      changes: changes(true),
    };
  }
  if (fromServer?.links != null || toServer.sessions !== null) {
    const noPath = noPathBetween(fromServer ?? null, toServer, from.onThisComputer);
    return {
      ...base,
      state: noPath ? { kind: "no-path" } : { kind: "none" },
      arrivedVia: null,
      arrivedFrom: null,
      changes: { ...changes(false), canRelink: !noPath && changes(false).canRelink },
    };
  }
  return {
    ...base,
    state: {
      kind: "unknown",
      reason: `This app cannot read the links on ${from.label} or who uses ${to.label}.`,
    },
    arrivedVia: null,
    arrivedFrom: null,
    changes: { ...changes(false), canRelink: false },
  };
}

function appSquare(app: ReachParty, to: ReachParty, server: ReachServerInput): ReachSquare {
  const changes: SquareChanges = {
    lockedReason: lockedReason(to, server),
    canRemove: false,
    canRelink: false,
    relinkBlockedReason: "This app keeps the level it paired with",
    ownOutbound: !server.onThisComputer,
  };
  const arrivedVia: Arrival | null =
    server.route === "ssh"
      ? "ssh"
      : server.route === "local"
        ? "same-computer"
        : server.route === "relay"
          ? null
          : arrivalFromUrl(server.routeUrl ?? undefined);
  return {
    from: app,
    to,
    link: null,
    sessionIds: [],
    arrivedVia,
    arrivedFrom: server.route === "relay" || server.route === "ssh" ? null : server.routeUrl,
    changes,
    state:
      server.appScopes === null
        ? { kind: "unknown", reason: `This app is not connected to ${to.label}.` }
        : { kind: "level", level: deviceLevel(server.appScopes), broken: null },
  };
}

function deviceSquare(
  from: ReachParty,
  to: ReachParty,
  server: ReachServerInput,
  sessions: ReadonlyArray<AuthClientSession>,
): ReachSquare {
  const changes: SquareChanges = {
    lockedReason: lockedReason(to, server),
    canRemove: manages(server) && sessions.length > 0,
    canRelink: false,
    relinkBlockedReason: "A device keeps the level it paired with. Pair it again to change it.",
    ownOutbound: false,
  };
  const base = { from, to, link: null, changes };
  if (server.sessions === null) {
    return {
      ...base,
      sessionIds: [],
      arrivedVia: null,
      arrivedFrom: null,
      state: { kind: "unknown", reason: `This app cannot read who uses ${to.label}.` },
    };
  }
  const strongest = sessions
    .map((session) =>
      from.kind === "agent"
        ? linkSessionLevel(session)
        : deviceLevel(session.permissions ?? session.scopes),
    )
    .toSorted((left, right) => LEVEL_RANK[right] - LEVEL_RANK[left])[0];
  return {
    ...base,
    sessionIds: sessions.map((session) => session.sessionId),
    // This app's own session is the current one and never a device, so no device is known local.
    ...(sessions[0]
      ? sessionArrival(sessions[0], server, false)
      : { arrivedVia: null, arrivedFrom: null }),
    state:
      strongest !== undefined
        ? { kind: "level", level: strongest, broken: null }
        : server.reachableFromOthers === false
          ? { kind: "no-path" }
          : { kind: "none" },
  };
}

const notConnected = (to: ReachParty) => `${to.label} is not connected to this app`;

/**
 * A known server's link to a server this app is not connected to: its level comes from the
 * linking side's own list, and only that side can give it up.
 */
function unconnectedLinkSquare(
  from: ReachParty,
  to: ReachParty,
  link: PeerLinkSummary,
  server: ReachServerInput,
): ReachSquare {
  return {
    from,
    to,
    link,
    sessionIds: [],
    arrivedVia: arrivalFromUrl(link.urls[0]),
    arrivedFrom: link.urls[0] ?? null,
    state: { kind: "level", level: link.access, broken: linkBroken(link) },
    changes: {
      lockedReason: notConnected(to),
      canRemove: manages(server),
      canRelink: false,
      relinkBlockedReason: `Renewing needs a new code from ${to.label}, which this app is not connected to`,
      // This app cannot reach the target to get it back, so giving it up always asks first.
      ownOutbound: true,
    },
  };
}

function unconnectedUnknownSquare(from: ReachParty, to: ReachParty): ReachSquare {
  return {
    from,
    to,
    link: null,
    sessionIds: [],
    arrivedVia: null,
    arrivedFrom: null,
    state: {
      kind: "unknown",
      reason: `${notConnected(to)}, so it cannot read who uses it.`,
    },
    changes: {
      lockedReason: notConnected(to),
      canRemove: false,
      canRelink: false,
      relinkBlockedReason: notConnected(to),
      ownOutbound: false,
    },
  };
}

/**
 * Device names, told apart where two match: first by address, then by server, then by
 * session. Every entry is one session on one server.
 */
function deviceLabels(
  entries: ReadonlyArray<{
    readonly key: string;
    readonly kind: PartyKind;
    readonly session: AuthClientSession;
    readonly serverLabel: string;
  }>,
): ReadonlyArray<{ readonly key: string; readonly kind: PartyKind; readonly label: string }> {
  // A detail is added to a group of matching names only when it tells them apart.
  const disambiguate = (
    labels: ReadonlyArray<string>,
    detail: (index: number) => string | undefined,
  ) => {
    const groups = new Map<string, number[]>();
    labels.forEach((label, index) => groups.set(label, [...(groups.get(label) ?? []), index]));
    const next = [...labels];
    for (const [label, indexes] of groups) {
      if (indexes.length < 2) continue;
      const details = indexes.map(detail);
      if (new Set(details).size < 2) continue;
      indexes.forEach((index, position) => {
        const extra = details[position];
        if (extra) next[index] = `${label} · ${extra}`;
      });
    }
    return next;
  };
  const named = entries.map((entry) => deviceName(entry.session));
  const byAddress = disambiguate(named, (index) => clientOf(entries[index]!.session).ipAddress);
  const byServer = disambiguate(byAddress, (index) => entries[index]!.serverLabel);
  const bySession = disambiguate(byServer, (index) =>
    entries[index]!.session.sessionId.slice(0, 6),
  );
  return entries.map((entry, index) => ({
    key: entry.key,
    kind: entry.kind,
    label: bySession[index]!,
  }));
}

/** Bron–Kerbosch: every largest group in which each pair has an edge. */
function maximalGroups(
  nodes: ReadonlyArray<string>,
  connected: (left: string, right: string) => boolean,
): string[][] {
  const groups: string[][] = [];
  const expand = (chosen: string[], candidates: string[], excluded: string[]) => {
    if (candidates.length === 0 && excluded.length === 0) {
      if (chosen.length > 1) groups.push(chosen);
      return;
    }
    let remaining = candidates;
    for (const node of candidates) {
      expand(
        [...chosen, node],
        remaining.filter((other) => other !== node && connected(node, other)),
        excluded.filter((other) => connected(node, other)),
      );
      remaining = remaining.filter((other) => other !== node);
      excluded = [...excluded, node];
    }
  };
  expand([], [...nodes], []);
  return groups;
}

export function buildReachModel(input: {
  readonly servers: ReadonlyArray<ReachServerInput>;
}): ReachModel {
  const servers = input.servers.toSorted(
    (left, right) => Number(right.onThisComputer) - Number(left.onThisComputer),
  );
  const byId = new Map(servers.map((server) => [server.environmentId, server]));
  const context: BuildContext = { byId };
  const columns: ReachParty[] = servers.map((server) => ({
    id: serverPartyId(server.environmentId),
    kind: "server",
    label: server.label,
    environmentId: server.environmentId,
    onThisComputer: server.onThisComputer,
  }));

  // Servers this app is not connected to: a row when they link in, a column when linked to.
  const outsideServers = new Map<EnvironmentId, ReachParty>();
  const linkTargets = new Map<EnvironmentId, ReachParty>();
  const outsideParty = (environmentId: EnvironmentId, label: string): ReachParty =>
    outsideServers.get(environmentId) ??
    linkTargets.get(environmentId) ?? {
      id: serverPartyId(environmentId),
      kind: "server",
      label,
      environmentId,
      onThisComputer: false,
    };
  const outsideServer = (environmentId: EnvironmentId, label: string) =>
    outsideServers.set(environmentId, outsideParty(environmentId, label));

  // Link sessions by linking environment, and device sessions by device, on each server.
  const linkSessions = new Map<EnvironmentId, Map<string, AuthClientSession[]>>();
  const deviceEntries: Array<{
    readonly key: string;
    readonly kind: PartyKind;
    readonly session: AuthClientSession;
    readonly serverLabel: string;
  }> = [];
  const deviceSessions = new Map<EnvironmentId, Map<string, AuthClientSession[]>>();
  for (const server of servers) {
    const byLinker = new Map<string, AuthClientSession[]>();
    const byDevice = new Map<string, AuthClientSession[]>();
    for (const session of server.sessions ?? []) {
      // T3 Connect devices are managed under Privacy, where revoking one can first turn on
      // approval; without it, a revoked device signs straight back in.
      if (session.current || session.subject === T3_CONNECT_SESSION_SUBJECT) continue;
      if (isLinkSession(session)) {
        const label = linkSessionLabel(session);
        const linkerId =
          linkSessionEnvironmentId(session) ??
          servers.find((candidate) => candidate.label === label)?.environmentId ??
          null;
        if (linkerId === null) continue;
        const partyId = serverPartyId(linkerId);
        if (!byId.has(linkerId)) outsideServer(linkerId, label);
        byLinker.set(partyId, [...(byLinker.get(partyId) ?? []), session]);
        continue;
      }
      // Each session is its own entry: names are not identities, so merging two sessions would
      // make one Remove revoke both.
      const key = `device:${server.environmentId}:${session.sessionId}`;
      deviceEntries.push({
        key,
        kind: session.subject === "mcp-client" ? "agent" : "device",
        session,
        serverLabel: server.label,
      });
      byDevice.set(key, [session]);
    }
    linkSessions.set(server.environmentId, byLinker);
    deviceSessions.set(server.environmentId, byDevice);
  }
  for (const server of servers) {
    for (const link of server.links ?? []) {
      if (!byId.has(link.environmentId)) {
        linkTargets.set(link.environmentId, outsideParty(link.environmentId, link.label));
      }
    }
  }

  const app: ReachParty = {
    id: APP_PARTY_ID,
    kind: "app",
    label: "This app",
    environmentId: null,
    onThisComputer: true,
  };
  const serverRows = [...columns, ...outsideServers.values()];
  const deviceRows = deviceLabels(deviceEntries)
    .map(({ key, kind, label }): ReachParty => ({
      id: key,
      kind,
      label,
      environmentId: null,
      onThisComputer: false,
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
  const rows = [...serverRows, app, ...deviceRows];

  const squares = new Map<string, ReachSquare>();
  for (const to of columns) {
    const toServer = byId.get(to.environmentId!)!;
    for (const from of serverRows) {
      const key = squareKey(from.id, to.id);
      if (from.id === to.id) {
        squares.set(key, {
          from,
          to,
          state: { kind: "self" },
          arrivedVia: null,
          arrivedFrom: null,
          sessionIds: [],
          link: null,
          changes: {
            lockedReason: null,
            canRemove: false,
            canRelink: false,
            relinkBlockedReason: null,
            ownOutbound: false,
          },
        });
        continue;
      }
      const sessionsFrom = linkSessions.get(toServer.environmentId)?.get(from.id) ?? [];
      squares.set(key, serverSquare(context, from, to, sessionsFrom));
    }
    squares.set(squareKey(app.id, to.id), appSquare(app, to, toServer));
    for (const device of deviceRows) {
      const sessions = deviceSessions.get(toServer.environmentId)?.get(device.id) ?? [];
      squares.set(squareKey(device.id, to.id), deviceSquare(device, to, toServer, sessions));
    }
  }

  // This app reads nothing on a link target, so only its linking servers' own lists speak for it.
  for (const to of linkTargets.values()) {
    for (const from of rows) {
      const fromServer = from.environmentId === null ? undefined : byId.get(from.environmentId);
      const link = fromServer?.links?.find(
        (candidate) => candidate.environmentId === to.environmentId,
      );
      squares.set(
        squareKey(from.id, to.id),
        from.id === to.id
          ? { ...unconnectedUnknownSquare(from, to), state: { kind: "self" } }
          : fromServer !== undefined && link !== undefined
            ? unconnectedLinkSquare(from, to, link, fromServer)
            : unconnectedUnknownSquare(from, to),
      );
    }
  }

  const isFull = (fromId: string, toId: string) => {
    const state = squares.get(squareKey(fromId, toId))?.state;
    return state?.kind === "level" && state.level === "full-access" && state.broken === null;
  };
  const trusted = maximalGroups(
    columns.map((column) => column.id),
    (left, right) => isFull(left, right) && isFull(right, left),
  ).map((group) => group.map((id) => columns.find((column) => column.id === id)!));

  const manageable = new Set(
    servers.filter(manages).map((server) => serverPartyId(server.environmentId)),
  );
  const deviceSessionByParty = new Map(deviceEntries.map((entry) => [entry.key, entry.session]));
  return {
    // The reverse of a link target is unknown, so it never joins a trusted group above.
    columns: [...columns, ...linkTargets.values()],
    unconnected: new Set([...linkTargets.values()].map((party) => party.id)),
    rows,
    squares,
    trusted,
    manageable,
    deviceSessions: deviceSessionByParty,
  };
}

/**
 * Who holds access to `to`, for its list. This app is left out: it is what the person is
 * looking through, and its own level shows in the grid.
 */
export function accessHolders(model: ReachModel, to: ReachParty): ReadonlyArray<ReachSquare> {
  return model.rows.flatMap((row) => {
    if (row.kind === "app") return [];
    const square = model.squares.get(squareKey(row.id, to.id));
    return square?.state.kind === "level" ? [square] : [];
  });
}

/** Phones, browsers and outside agents: what connects in and is not a server or this app. */
export const deviceParties = (model: ReachModel): ReadonlyArray<ReachParty> =>
  model.rows.filter((row) => row.kind === "device" || row.kind === "agent");

export type SquareTarget = LinkLevelChoice | "none";

export type SquareChangePlan =
  | { readonly kind: "blocked"; readonly reason: string }
  | ({
      readonly kind: "apply" | "confirm";
      /** What will happen, shown before a raise or before giving up one's own access. */
      readonly sentence: string | null;
    } & (
      | { readonly action: "relink"; readonly target: LinkLevelChoice }
      | { readonly action: "remove"; readonly target: "none" }
    ));

/**
 * How a click on a level plays out. Raising and renewing show what will happen first; lowering
 * or removing applies at once, unless it gives up access this computer holds elsewhere.
 */
export function planSquareChange(square: ReachSquare, target: SquareTarget): SquareChangePlan {
  const { from, to, changes, state } = square;
  const current = state.kind === "level" ? state.level : null;
  const broken = state.kind === "level" && state.broken !== null;
  const getBack = `Getting it back needs approval on ${to.label}, or SSH.`;
  if (target === "none") {
    if (!changes.canRemove) {
      return { kind: "blocked", reason: changes.lockedReason ?? "Nothing to remove" };
    }
    return changes.ownOutbound
      ? {
          kind: "confirm",
          action: "remove",
          target,
          sentence: `${from.label} gives up its access to ${to.label}. ${getBack}`,
        }
      : { kind: "apply", action: "remove", target, sentence: null };
  }
  if (!changes.canRelink) {
    return { kind: "blocked", reason: changes.relinkBlockedReason ?? "Cannot change this here" };
  }
  if (current === target && !broken) {
    return { kind: "blocked", reason: `Already ${REACH_LEVEL_LABELS[target]}` };
  }
  const label = REACH_LEVEL_LABELS[target];
  if (broken || isRaise(current, target)) {
    return {
      kind: "confirm",
      action: "relink",
      target,
      sentence: `${from.label} gets ${label} on ${to.label}. ${to.label} issues a new code and ${from.label} links again with it.`,
    };
  }
  return changes.ownOutbound
    ? {
        kind: "confirm",
        action: "relink",
        target,
        sentence: `${from.label} drops to ${label} on ${to.label}. ${getBack}`,
      }
    : { kind: "apply", action: "relink", target, sentence: null };
}
