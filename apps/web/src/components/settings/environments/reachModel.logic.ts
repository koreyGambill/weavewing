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
  /** Sessions on the receiving server that make up this square, for removal. */
  readonly sessionIds: ReadonlyArray<AuthClientSession["sessionId"]>;
  /** The linking side's record, when it could be read. */
  readonly link: PeerLinkSummary | null;
  readonly changes: SquareChanges;
}

/** A line under a server's "Going out": one of its links, including to servers this app lacks. */
export interface OutgoingLink {
  readonly link: PeerLinkSummary;
  readonly target: ReachParty;
  readonly square: ReachSquare | null;
}

export interface ReachModel {
  readonly columns: ReadonlyArray<ReachParty>;
  readonly rows: ReadonlyArray<ReachParty>;
  readonly squares: ReadonlyMap<string, ReachSquare>;
  /** Groups of servers with Full access to each other in both directions. */
  readonly trusted: ReadonlyArray<ReadonlyArray<ReachParty>>;
  readonly outgoing: ReadonlyMap<EnvironmentId, ReadonlyArray<OutgoingLink>>;
}

export const APP_PARTY_ID = "app";
export const serverPartyId = (environmentId: EnvironmentId) => `server:${environmentId}`;
export const squareKey = (fromId: string, toId: string) => `${fromId}>${toId}`;

const LINK_LABEL_PREFIX = /^(Linked environment|T3 Code) · /;

function grants(session: AuthClientSession, scope: AuthEnvironmentScope): boolean {
  return (session.permissions ?? session.scopes).includes(scope);
}

/** The level a link session holds, which its scopes only tell apart at the ends. */
export function linkSessionLevel(session: AuthClientSession): ReachLevel {
  if (!grants(session, AuthOrchestrationOperateScope)) return "read-only";
  return grants(session, AuthSettingsWriteScope) ? "full-access" : "can-change";
}

/** Full access manages who else has access; anything short of it is hand-picked. */
export function deviceLevel(scopes: ReadonlyArray<AuthEnvironmentScope>): ReachLevel {
  if (!scopes.includes(AuthOrchestrationOperateScope)) return "read-only";
  return scopes.includes(AuthAccessWriteScope) ? "full-access" : "custom";
}

function isLinkSession(session: AuthClientSession): boolean {
  return (
    session.subject.startsWith(MCP_PEER_LINK_SUBJECT_PREFIX) ||
    (session.subject === "mcp-client" && LINK_LABEL_PREFIX.test(session.client.label ?? ""))
  );
}

function linkSessionLabel(session: AuthClientSession): string {
  return (session.client.label ?? "Linked environment").replace(LINK_LABEL_PREFIX, "");
}

/** The machine a link session belongs to: its id when the server recorded it. */
function linkSessionEnvironmentId(session: AuthClientSession): EnvironmentId | null {
  return session.subject.startsWith(MCP_PEER_LINK_SUBJECT_PREFIX)
    ? (session.subject.slice(MCP_PEER_LINK_SUBJECT_PREFIX.length) as EnvironmentId)
    : null;
}

function deviceName(session: AuthClientSession): string {
  const client = session.client;
  if (client.label) return client.label;
  const parts = [client.browser, client.os].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" on ") : "Unnamed device";
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

const arrivalFromUrl = (url: string | undefined) =>
  url === undefined ? null : arrivalFromHost(hostOf(url));

const lockedReason = (to: ReachParty, server: ReachServerInput | undefined) =>
  server?.canManage ? null : `Set on ${to.label}`;

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
  const canRelinkBase =
    toServer.canManage &&
    fromServer !== undefined &&
    fromServer.canManage &&
    fromServer.linksOffered &&
    toServer.linksOffered &&
    fromServer.appScopes !== null &&
    toServer.appScopes !== null;
  const relinkBlockedReason = !toServer.canManage
    ? `Set on ${to.label}`
    : fromServer === undefined || fromServer.appScopes === null
      ? `This app does not reach ${from.label}`
      : !fromServer.canManage
        ? `Changing the level needs this app to manage ${from.label} too`
        : !fromServer.linksOffered || !toServer.linksOffered
          ? "Linked environments is off on one of them (Settings → Labs)"
          : toServer.appScopes === null
            ? `This app does not reach ${to.label}`
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
      ((toServer.canManage && sessionsFrom.length > 0) ||
        (link !== null && fromServer?.canManage === true)),
    canRelink: canRelinkBase && relinkBlockedReason === null,
    relinkBlockedReason,
    ownOutbound,
  });

  if (link !== null) {
    return {
      ...base,
      state: {
        kind: "level",
        level: link.access,
        broken:
          link.status === "expired"
            ? "expired"
            : link.status === "unauthorized"
              ? "unauthorized"
              : null,
      },
      arrivedVia: arrivalFromUrl(link.urls[0]),
      changes: changes(true),
    };
  }
  const linkSession = sessionsFrom[0];
  // The linking side's list is the record of what it holds; a session it forgot grants nothing.
  if (fromServer?.links == null && linkSession !== undefined) {
    return {
      ...base,
      state: { kind: "level", level: linkSessionLevel(linkSession), broken: null },
      arrivedVia: arrivalFromHost(linkSession.client.ipAddress ?? null),
      changes: changes(true),
    };
  }
  if (fromServer?.links != null || toServer.sessions !== null) {
    const noPath = noPathBetween(fromServer ?? null, toServer, from.onThisComputer);
    return {
      ...base,
      state: noPath ? { kind: "no-path" } : { kind: "none" },
      arrivedVia: null,
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
    canRemove: server.canManage && sessions.length > 0,
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
    arrivedVia: arrivalFromHost(sessions[0]?.client.ipAddress ?? null),
    state:
      strongest !== undefined
        ? { kind: "level", level: strongest, broken: null }
        : server.reachableFromOthers === false
          ? { kind: "no-path" }
          : { kind: "none" },
  };
}

function deviceKey(session: AuthClientSession, kind: PartyKind): string {
  return `${kind}:${deviceName(session).toLowerCase()}`;
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

  // Servers known only because they link in or are linked to.
  const outsideServers = new Map<EnvironmentId, ReachParty>();
  const outsideServer = (environmentId: EnvironmentId, label: string) => {
    const known = outsideServers.get(environmentId);
    if (known) return known;
    const party: ReachParty = {
      id: serverPartyId(environmentId),
      kind: "server",
      label,
      environmentId,
      onThisComputer: false,
    };
    outsideServers.set(environmentId, party);
    return party;
  };

  // Link sessions by linking environment, and device sessions by device, on each server.
  const linkSessions = new Map<EnvironmentId, Map<string, AuthClientSession[]>>();
  const devices = new Map<string, ReachParty>();
  const deviceSessions = new Map<EnvironmentId, Map<string, AuthClientSession[]>>();
  for (const server of servers) {
    const byLinker = new Map<string, AuthClientSession[]>();
    const byDevice = new Map<string, AuthClientSession[]>();
    for (const session of server.sessions ?? []) {
      if (session.current) continue;
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
      const kind: PartyKind = session.subject === "mcp-client" ? "agent" : "device";
      const key = deviceKey(session, kind);
      if (!devices.has(key)) {
        devices.set(key, {
          id: key,
          kind,
          label: deviceName(session),
          environmentId: null,
          onThisComputer: false,
        });
      }
      byDevice.set(key, [...(byDevice.get(key) ?? []), session]);
    }
    linkSessions.set(server.environmentId, byLinker);
    deviceSessions.set(server.environmentId, byDevice);
  }
  for (const server of servers) {
    for (const link of server.links ?? []) {
      if (!byId.has(link.environmentId)) outsideServer(link.environmentId, link.label);
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
  const deviceRows = [...devices.values()].toSorted((left, right) =>
    left.label.localeCompare(right.label),
  );
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

  const isFull = (fromId: string, toId: string) => {
    const state = squares.get(squareKey(fromId, toId))?.state;
    return state?.kind === "level" && state.level === "full-access" && state.broken === null;
  };
  const trusted = maximalGroups(
    columns.map((column) => column.id),
    (left, right) => isFull(left, right) && isFull(right, left),
  ).map((group) => group.map((id) => columns.find((column) => column.id === id)!));

  const outgoing = new Map<EnvironmentId, OutgoingLink[]>();
  for (const server of servers) {
    outgoing.set(
      server.environmentId,
      (server.links ?? []).map((link) => {
        const target =
          columns.find((column) => column.environmentId === link.environmentId) ??
          outsideServers.get(link.environmentId)!;
        return {
          link,
          target,
          square: squares.get(squareKey(serverPartyId(server.environmentId), target.id)) ?? null,
        };
      }),
    );
  }

  return { columns, rows, squares, trusted, outgoing };
}

/** Every square into `to` that holds some access, for a server's "Coming in" lines. */
export function incomingSquares(model: ReachModel, to: ReachParty): ReadonlyArray<ReachSquare> {
  return model.rows.flatMap((row) => {
    const square = model.squares.get(squareKey(row.id, to.id));
    return square?.state.kind === "level" ? [square] : [];
  });
}
