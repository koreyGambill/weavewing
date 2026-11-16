import * as NodeNet from "node:net";

import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { buildPairingAppLink, setPairingTokenOnUrl } from "@t3tools/shared/remote";
import {
  isTailscaleIpv4Address,
  type TailscaleNode,
  type TailscaleWhois,
} from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TailscaleClient from "./TailscaleClient.ts";

export const TAILNET_PAGE_PATH = "/tailnet";
export const TAILNET_PAIR_PATH = "/tailnet/pair";

const decodedPath = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * Whether a request path, query included, may reach a tailnet page. Normalised as loosely as the
 * router matches: case, repeated and trailing slashes, and percent-encoding are all ignored.
 */
export const isTailnetPagePath = (url: string) => {
  const pathname = decodedPath(url.split(/[?#]/u, 1)[0] ?? "")
    .toLowerCase()
    .replace(/\/{2,}/gu, "/")
    .replace(/(.)\/$/u, "$1");
  return pathname === TAILNET_PAGE_PATH || pathname.startsWith(`${TAILNET_PAGE_PATH}/`);
};

const WHOIS_CACHE_TTL = Duration.seconds(30);
const PEERS_CACHE_TTL = Duration.seconds(30);
const PROBE_TIMEOUT = Duration.millis(1_500);
const PROBE_CONCURRENCY = 8;
const PAIRING_LIMIT = 10;
const PAIRING_LIMIT_WINDOW = Duration.minutes(10);
// Each listing probes up to MAX_PROBES addresses, so a caller cannot make the server scan freely.
const LISTING_LIMIT = 20;
const LISTING_LIMIT_WINDOW = Duration.minutes(1);
const MAX_PROBES = 48;

export const TailnetConnectRefusal = Schema.Literals([
  "disabled",
  "not_tailnet",
  "own_machine",
  "cross_site",
  "host_not_allowed",
  "unknown_peer",
  "tagged_node",
  "shared_node",
  "login_not_allowed",
  "server_tagged",
  "rate_limited",
  "tailscale_unavailable",
  "remote_clients_disallowed",
]);
export type TailnetConnectRefusal = typeof TailnetConnectRefusal.Type;

export class TailnetConnectRefusedError extends Schema.TaggedError<TailnetConnectRefusedError>()(
  "TailnetConnectRefusedError",
  { reason: TailnetConnectRefusal, detail: Schema.optionalKey(Schema.String) },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return `Tailnet pairing is off on this server. Turn it on in Settings → Privacy for ${this.detail ?? "this environment"}.`;
      case "not_tailnet":
        return "Open this page over the tailnet, at this machine's Tailscale address.";
      case "own_machine":
        return "This machine cannot pair with itself over the tailnet. Open this page from another device.";
      case "cross_site":
        return "Another website tried to use this page. Open it directly instead.";
      case "host_not_allowed":
        return "Open this page at this machine's Tailscale address or full MagicDNS name.";
      case "unknown_peer":
        return "Tailscale does not know the device this request came from.";
      case "tagged_node":
        return "Tagged devices cannot pair. Open this page from a device signed in as a person.";
      case "shared_node":
        return "Devices shared in from another tailnet cannot pair.";
      case "login_not_allowed":
        return "Your Tailscale login is not allowed to pair with this server.";
      case "server_tagged":
        return "This server is a tagged Tailscale node, which belongs to no person. List the logins that may pair under Allowed Tailscale logins in its Privacy settings.";
      case "rate_limited":
        return "Too many requests from this device. Wait a few minutes and try again.";
      case "tailscale_unavailable":
        return "Tailscale did not answer on this server. Check that Tailscale is running.";
      case "remote_clients_disallowed":
        return this.detail ?? "This server's policy does not allow pairing other devices.";
    }
  }
}

export class TailnetPairingIssueError extends Schema.TaggedError<TailnetPairingIssueError>()(
  "TailnetPairingIssueError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server could not create a pairing link.";
  }
}

/** What the transport knows about a request: its socket ends and the Host it named. */
export interface TailnetRequest {
  readonly remoteAddress: string | undefined;
  readonly localAddress: string | undefined;
  readonly host: string | undefined;
}

export interface TailnetCaller {
  readonly login: string;
  readonly nodeName: string | null;
  readonly address: string;
}

export interface TailnetEnvironmentEntry {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: string | null;
  /** The host and port it answers on. */
  readonly address: string;
  /** That server's own pairing page; each server authorizes and mints for itself. */
  readonly pairUrl: string;
  readonly current: boolean;
}

export interface TailnetPairing {
  readonly caller: TailnetCaller;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly appLink: string;
  readonly expiresAt: DateTime.Utc;
}

export class TailnetConnect extends Context.Service<
  TailnetConnect,
  {
    /** Checks the caller without minting, for the page that asks before it does. */
    readonly describePairing: (
      request: TailnetRequest,
    ) => Effect.Effect<
      { readonly caller: TailnetCaller; readonly environmentLabel: string },
      TailnetConnectRefusedError
    >;
    readonly listEnvironments: (request: TailnetRequest) => Effect.Effect<
      {
        readonly caller: TailnetCaller;
        readonly environments: ReadonlyArray<TailnetEnvironmentEntry>;
      },
      TailnetConnectRefusedError
    >;
    readonly issuePairing: (
      request: TailnetRequest,
    ) => Effect.Effect<TailnetPairing, TailnetConnectRefusedError | TailnetPairingIssueError>;
  }
>()("t3/tailnet/TailnetConnect") {}

const ProbedDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
const decodeProbedDescriptor = HttpClientResponse.schemaBodyJson(ProbedDescriptor);

const unmapIpv4 = (address: string) => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/iu, "");

const isTailnetIpv6Address = (address: string) => {
  if (!NodeNet.isIPv6(address)) return false;
  const blocks = new NodeNet.BlockList();
  blocks.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");
  return blocks.check(address, "ipv6");
};

/** A peer's tailnet address, or undefined for loopback, LAN and anything else. */
const tailnetAddress = (address: string | undefined): string | undefined => {
  if (address === undefined) return undefined;
  const unmapped = unmapIpv4(address.trim());
  return isTailscaleIpv4Address(unmapped) || isTailnetIpv6Address(unmapped) ? unmapped : undefined;
};

const hostnameOf = (host: string) => {
  const parsed = URL.canParse(`http://${host}`) ? new URL(`http://${host}`) : undefined;
  return parsed?.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
};

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const make = Effect.gen(function* () {
  const tailscale = yield* TailscaleClient.TailscaleClient;
  const settingsService = yield* ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;
  const { port: serverPort } = yield* ServerConfig.ServerConfig;

  const refuse = (reason: TailnetConnectRefusal, detail?: string) =>
    Effect.fail(
      new TailnetConnectRefusedError(detail === undefined ? { reason } : { reason, detail }),
    );
  const unavailable = () => refuse("tailscale_unavailable");

  const whoisCache = yield* Ref.make(
    new Map<string, { readonly expiresAt: number; readonly whois: TailscaleWhois | null }>(),
  );
  const pairingsByAddress = yield* Ref.make(new Map<string, ReadonlyArray<number>>());
  const listingsByAddress = yield* Ref.make(new Map<string, ReadonlyArray<number>>());
  // Every page load needs this node's facts; `tailscale status` can take seconds on Windows.
  const peers = yield* Effect.cachedWithTTL(tailscale.peers, PEERS_CACHE_TTL);

  const whois = Effect.fn("TailnetConnect.whois")(function* (address: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(whoisCache)).get(address);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.whois;
    }
    const result = yield* tailscale.whois(address);
    yield* Ref.update(whoisCache, (cache) => {
      const next = new Map([...cache].filter(([, entry]) => entry.expiresAt > now));
      next.set(address, { expiresAt: now + Duration.toMillis(WHOIS_CACHE_TTL), whois: result });
      return next;
    });
    return result;
  });

  const isOwnHost = Effect.fn("TailnetConnect.isOwnHost")(function* (host: string | undefined) {
    const hostname = host === undefined ? undefined : hostnameOf(host);
    if (hostname === undefined || hostname.length === 0) return false;
    // A DNS-rebinding page names a domain its owner controls. An address literal cannot be one, and
    // only Tailscale answers for the MagicDNS name; a short name follows the device's search domains.
    if (NodeNet.isIP(hostname) !== 0) return true;
    const self = (yield* peers.pipe(Effect.catch(unavailable))).self;
    const magicDnsName = self?.magicDnsName?.toLowerCase();
    return magicDnsName !== undefined && hostname.replace(/\.$/u, "") === magicDnsName;
  });

  const authorize = Effect.fn("TailnetConnect.authorize")(function* (request: TailnetRequest) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.map((value) => value.tailnetConnect),
      Effect.orElseSucceed(() => null),
    );
    if (settings === null || !settings.enabled) {
      return yield* refuse("disabled", (yield* serverEnvironment.getDescriptor).label);
    }
    const address = tailnetAddress(request.remoteAddress);
    // Tailscale Serve and T3 Connect reach the server over loopback, so they never count.
    if (address === undefined || tailnetAddress(request.localAddress) === undefined) {
      return yield* refuse("not_tailnet");
    }
    // Any process on this machine, the Windows host's included under WSL, would pass as its owner.
    if (address === tailnetAddress(request.localAddress)) return yield* refuse("own_machine");
    if (!(yield* isOwnHost(request.host))) return yield* refuse("host_not_allowed");
    const self = (yield* peers.pipe(Effect.catch(unavailable))).self;
    if (self?.tailnetAddresses.some((own) => tailnetAddress(own) === address)) {
      return yield* refuse("own_machine");
    }
    const peer = yield* whois(address).pipe(Effect.catch(unavailable));
    if (peer === null) return yield* refuse("unknown_peer");
    if (peer.tagged) return yield* refuse("tagged_node");
    if (peer.shared) return yield* refuse("shared_node");
    if (settings.allowedLogins.length === 0 && self?.tagged === true) {
      return yield* refuse("server_tagged");
    }
    const allowedLogins =
      settings.allowedLogins.length > 0
        ? settings.allowedLogins
        : [self?.login].filter((login): login is string => login != null);
    const login = peer.login;
    if (login === null || !allowedLogins.some((allowed) => sameLogin(allowed, login))) {
      return yield* refuse("login_not_allowed");
    }
    return {
      caller: { login, nodeName: peer.nodeName, address } satisfies TailnetCaller,
      origin: `http://${request.host}`,
      discoveryPorts: settings.discoveryPorts,
    };
  });

  /** Records one use for `address`, or false when it already used `limit` within `window`. */
  const takeSlot = Effect.fn("TailnetConnect.takeSlot")(function* (
    uses: Ref.Ref<Map<string, ReadonlyArray<number>>>,
    address: string,
    limit: number,
    window: Duration.Duration,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const windowStart = now - Duration.toMillis(window);
    return yield* Ref.modify(uses, (byAddress) => {
      const recent = (byAddress.get(address) ?? []).filter((at) => at > windowStart);
      if (recent.length >= limit) return [false, byAddress] as const;
      const next = new Map(
        [...byAddress].filter(([, times]) => times.some((at) => at > windowStart)),
      );
      next.set(address, [...recent, now]);
      return [true, next] as const;
    });
  });

  const probe = Effect.fn("TailnetConnect.probe")(
    function* (node: TailscaleNode & { readonly tailnetIpv4Address: string }, port: number) {
      const origin = `http://${node.tailnetIpv4Address}:${port}`;
      const descriptor = yield* httpClient
        .execute(
          HttpClientRequest.get(`${origin}/.well-known/t3/environment`).pipe(
            HttpClientRequest.acceptJson,
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeProbedDescriptor),
          Effect.timeoutOption(PROBE_TIMEOUT),
        );
      return Option.map(descriptor, (found) => ({
        environmentId: found.environmentId,
        label: found.label,
        machine: node.name,
        address: `${node.tailnetIpv4Address}:${port}`,
        pairUrl: `${origin}${TAILNET_PAIR_PATH}`,
        current: false,
      }));
    },
    Effect.scoped,
    Effect.orElseSucceed(() => Option.none<TailnetEnvironmentEntry>()),
  );

  const listEnvironments: TailnetConnect["Service"]["listEnvironments"] = Effect.fn(
    "TailnetConnect.listEnvironments",
  )(function* (request) {
    const { caller, discoveryPorts } = yield* authorize(request);
    if (
      !(yield* takeSlot(listingsByAddress, caller.address, LISTING_LIMIT, LISTING_LIMIT_WINDOW))
    ) {
      return yield* refuse("rate_limited");
    }
    const descriptor = yield* serverEnvironment.getDescriptor;
    const tailnet = yield* peers.pipe(Effect.catch(unavailable));
    const ports = [...new Set([...discoveryPorts, ...(serverPort > 0 ? [serverPort] : [])])];
    const nodes = [
      ...(tailnet.self === null ? [] : [tailnet.self]),
      ...tailnet.peers.filter(
        (peer) =>
          peer.online &&
          !peer.tagged &&
          !peer.shared &&
          peer.login !== null &&
          sameLogin(peer.login, caller.login),
      ),
    ].filter(
      (node): node is TailscaleNode & { readonly tailnetIpv4Address: string } =>
        node.tailnetIpv4Address !== null,
    );
    const found = yield* Effect.forEach(
      nodes
        .flatMap((node) =>
          ports
            .filter((port) => !(node === tailnet.self && port === serverPort))
            .map((port) => [node, port] as const),
        )
        .slice(0, MAX_PROBES),
      ([node, port]) => probe(node, port),
      { concurrency: PROBE_CONCURRENCY },
    );
    const environments: Array<TailnetEnvironmentEntry> = [
      {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        machine: tailnet.self?.name ?? null,
        address: request.host ?? "",
        pairUrl: TAILNET_PAIR_PATH,
        current: true,
      },
    ];
    for (const entry of found) {
      if (Option.isNone(entry)) continue;
      if (environments.some((known) => known.environmentId === entry.value.environmentId)) continue;
      environments.push(entry.value);
    }
    return { caller, environments };
  });

  const issuePairing: TailnetConnect["Service"]["issuePairing"] = Effect.fn(
    "TailnetConnect.issuePairing",
  )(function* (request) {
    const { caller, origin } = yield* authorize(request);
    if (
      !(yield* takeSlot(pairingsByAddress, caller.address, PAIRING_LIMIT, PAIRING_LIMIT_WINDOW))
    ) {
      return yield* refuse("rate_limited");
    }
    const descriptor = yield* serverEnvironment.getDescriptor;
    const issued = yield* environmentAuth
      .issuePairingCredential({ label: `Tailnet: ${caller.nodeName ?? caller.address}` })
      .pipe(
        Effect.catchTags({
          ManagedPolicyRefusedError: (error) => refuse("remote_clients_disallowed", error.message),
        }),
        Effect.mapError((cause) =>
          cause._tag === "TailnetConnectRefusedError"
            ? cause
            : new TailnetPairingIssueError({ cause }),
        ),
      );
    const pairingUrl = setPairingTokenOnUrl(new URL("/pair", origin), issued.credential).toString();
    return {
      caller,
      environmentLabel: descriptor.label,
      pairingUrl,
      appLink: buildPairingAppLink(pairingUrl),
      expiresAt: issued.expiresAt,
    };
  });

  const describePairing: TailnetConnect["Service"]["describePairing"] = Effect.fn(
    "TailnetConnect.describePairing",
  )(function* (request) {
    const { caller } = yield* authorize(request);
    const descriptor = yield* serverEnvironment.getDescriptor;
    return { caller, environmentLabel: descriptor.label };
  });

  return TailnetConnect.of({ describePairing, listEnvironments, issuePairing });
});

export const layer = Layer.effect(TailnetConnect, make);
