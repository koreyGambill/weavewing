import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { getPairingTokenFromUrl, readPairingAppLink } from "@t3tools/shared/remote";
import type { DeepPartial } from "@t3tools/shared/Struct";
import type { TailscaleNode, TailscaleWhois } from "@t3tools/tailscale";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TailnetConnect from "./TailnetConnect.ts";
import * as TailscaleClient from "./TailscaleClient.ts";

const OWNER = "me@example.com";
const SERVER_PORT = 3774;
const SELF_ID = EnvironmentId.make("env-self");

const node = (overrides: Partial<TailscaleNode>): TailscaleNode => ({
  name: null,
  magicDnsName: null,
  tailnetIpv4Address: null,
  tailnetAddresses: [],
  online: true,
  login: OWNER,
  tagged: false,
  shared: false,
  ...overrides,
});

const SELF = node({
  name: "desk",
  magicDnsName: "desk.tail.ts.net",
  tailnetIpv4Address: "100.64.0.1",
  tailnetAddresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
});

const person = (login: string, nodeName = "phone"): TailscaleWhois => ({
  nodeName,
  login,
  tagged: false,
  shared: false,
});

const WHOIS: Record<string, TailscaleWhois | null> = {
  "100.64.0.9": person(OWNER),
  "100.64.0.10": person("friend@example.com"),
  "100.64.0.11": { nodeName: "ci", login: null, tagged: true, shared: false },
  "100.64.0.12": { ...person(OWNER, "guest"), shared: true },
  "fd7a:115c:a1e0::9": person(OWNER),
};

const layerServerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, port: SERVER_PORT })),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-test-" })));

const layerTailnet = (input: {
  readonly settings?: DeepPartial<ServerSettings["tailnetConnect"]>;
  readonly self?: TailscaleNode;
  readonly peers?: ReadonlyArray<TailscaleNode>;
  /** A descriptor, `hang` for a probe that never answers, or nothing for a 404. */
  readonly answer?: (
    url: string,
  ) => { readonly environmentId: string; readonly label: string } | "hang" | undefined;
  readonly probed?: Array<string>;
}) =>
  TailnetConnect.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          TailscaleClient.TailscaleClient,
          TailscaleClient.TailscaleClient.of({
            whois: (address) => Effect.succeed(WHOIS[address] ?? null),
            peers: Effect.succeed({
              running: true,
              self: input.self ?? SELF,
              peers: input.peers ?? [],
            }),
          }),
        ),
        ServerSettingsService.layerTest({ tailnetConnect: { enabled: true, ...input.settings } }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: SELF_ID,
            label: "Desk",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            input.probed?.push(request.url);
            const descriptor = input.answer?.(request.url);
            if (descriptor === "hang") return Effect.never;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                descriptor === undefined
                  ? new Response(null, { status: 404 })
                  : Response.json(descriptor),
              ),
            );
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(ServerEnvironment.layerIdentity),
      ),
    ),
    Layer.provideMerge(layerServerConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const fromPeer = (
  remoteAddress: string,
  host = `100.64.0.1:${SERVER_PORT}`,
): TailnetConnect.TailnetRequest => ({
  remoteAddress,
  localAddress: "100.64.0.1",
  host,
});

const refusalOf = (request: TailnetConnect.TailnetRequest) =>
  Effect.flatMap(TailnetConnect.TailnetConnect, (service) =>
    service.listEnvironments(request).pipe(
      Effect.match({
        onFailure: (error) => error.reason,
        onSuccess: (page) => `allowed ${page.caller.login}`,
      }),
    ),
  );

it.effect("admits only the allowed logins' own devices, asking Tailscale who they are", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [TailnetConnect.TailnetRequest, string]> = [
      [fromPeer("100.64.0.9"), `allowed ${OWNER}`],
      [fromPeer("::ffff:100.64.0.9"), `allowed ${OWNER}`],
      [fromPeer("fd7a:115c:a1e0::9"), `allowed ${OWNER}`],
      [fromPeer("100.64.0.9", `desk.tail.ts.net:${SERVER_PORT}`), `allowed ${OWNER}`],
      [fromPeer("100.64.0.9", `DESK.tail.ts.net.:${SERVER_PORT}`), `allowed ${OWNER}`],
      // A short name resolves through the device's search domains, which the tailnet does not own.
      [fromPeer("100.64.0.9", `desk:${SERVER_PORT}`), "host_not_allowed"],
      [fromPeer("100.64.0.10"), "login_not_allowed"],
      [fromPeer("100.64.0.11"), "tagged_node"],
      [fromPeer("100.64.0.12"), "shared_node"],
      [fromPeer("100.64.0.99"), "unknown_peer"],
      [fromPeer("192.168.1.20"), "not_tailnet"],
      // Any process on the server's machine, the Windows host's included under WSL.
      [fromPeer("100.64.0.1"), "own_machine"],
      [fromPeer("fd7a:115c:a1e0::1"), "own_machine"],
      // Tailscale Serve and T3 Connect proxy over loopback.
      [{ remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", host: "x" }, "not_tailnet"],
      [{ ...fromPeer("100.64.0.9"), localAddress: "192.168.1.5" }, "not_tailnet"],
      // A DNS-rebinding page reaches this address under its own name.
      [fromPeer("100.64.0.9", `evil.example:${SERVER_PORT}`), "host_not_allowed"],
      [{ ...fromPeer("100.64.0.9"), host: undefined }, "host_not_allowed"],
    ];
    const results = yield* Effect.forEach(cases, ([request]) => refusalOf(request));
    assert.deepEqual(
      results,
      cases.map(([, expected]) => expected),
    );
  }).pipe(Effect.provide(layerTailnet({}))),
);

it.effect(
  "refuses everyone while the setting is off, naming the environment to turn it on in",
  () =>
    Effect.gen(function* () {
      const service = yield* TailnetConnect.TailnetConnect;
      const error = yield* Effect.flip(service.listEnvironments(fromPeer("100.64.0.9")));
      assert.equal(error.reason, "disabled");
      assert.match(error.message, /\boff\b/);
      assert.include(error.message, "Desk");
    }).pipe(Effect.provide(layerTailnet({ settings: { enabled: false } }))),
);

it.effect("asks for allowed logins on a tagged server, which has no owner", () =>
  Effect.gen(function* () {
    assert.equal(yield* refusalOf(fromPeer("100.64.0.9")), "server_tagged");
  }).pipe(Effect.provide(layerTailnet({ self: { ...SELF, login: null, tagged: true } }))),
);

it.effect("caps how often one device can make the server scan the tailnet", () =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(Array.from({ length: 21 }), () =>
      refusalOf(fromPeer("100.64.0.9")),
    );
    assert.deepEqual(results.slice(19), [`allowed ${OWNER}`, "rate_limited"]);
    yield* TestClock.adjust("1 minute");
    assert.equal(yield* refusalOf(fromPeer("100.64.0.9")), `allowed ${OWNER}`);
  }).pipe(Effect.provide(layerTailnet({}))),
);

it.effect("replaces the node owner with the configured logins", () =>
  Effect.gen(function* () {
    assert.equal(yield* refusalOf(fromPeer("100.64.0.9")), "login_not_allowed");
    assert.equal(yield* refusalOf(fromPeer("100.64.0.10")), "allowed friend@example.com");
  }).pipe(Effect.provide(layerTailnet({ settings: { allowedLogins: ["Friend@Example.com"] } }))),
);

it.effect("mints a standard one-time pairing link the T3 apps accept, at most ten a window", () =>
  Effect.gen(function* () {
    const service = yield* TailnetConnect.TailnetConnect;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    // The page that asks first mints nothing.
    const described = yield* service.describePairing(fromPeer("100.64.0.9"));
    assert.equal(described.environmentLabel, "Desk");
    assert.deepEqual(yield* auth.listPairingLinks(), []);

    const pairing = yield* service.issuePairing(fromPeer("100.64.0.9"));

    const pairingUrl = new URL(pairing.pairingUrl);
    assert.equal(pairingUrl.origin, `http://100.64.0.1:${SERVER_PORT}`);
    assert.equal(pairingUrl.pathname, "/pair");
    assert.equal(readPairingAppLink(pairing.appLink), pairing.pairingUrl);
    assert.isAbove(getPairingTokenFromUrl(pairingUrl)?.length ?? 0, 0);
    const links = yield* auth.listPairingLinks();
    assert.deepEqual(
      links.map((link) => [link.subject, link.label, link.permissions]),
      [["one-time-token", "Tailnet: phone", AuthStandardClientScopes]],
    );

    for (let index = 1; index < 10; index += 1) {
      yield* service.issuePairing(fromPeer("100.64.0.9"));
    }
    const refused = yield* service.issuePairing(fromPeer("100.64.0.9")).pipe(Effect.flip);
    assert.equal(refused._tag === "TailnetConnectRefusedError" && refused.reason, "rate_limited");
    yield* TestClock.adjust("10 minutes");
    yield* service.issuePairing(fromPeer("100.64.0.9"));
  }).pipe(Effect.provide(layerTailnet({}))),
);

it.effect("lists this server and each of the caller's other servers once", () => {
  const probed: Array<string> = [];
  const answers: Record<
    string,
    { readonly environmentId: string; readonly label: string } | "hang"
  > = {
    // Another server on this machine, and one machine's server on two ports.
    "http://100.64.0.1:3773/.well-known/t3/environment": { environmentId: "wsl", label: "WSL" },
    "http://100.64.0.2:3773/.well-known/t3/environment": { environmentId: "lap", label: "Laptop" },
    "http://100.64.0.2:3774/.well-known/t3/environment": { environmentId: "lap", label: "Laptop" },
    // A forwarded port that reaches this server again.
    "http://100.64.0.3:3774/.well-known/t3/environment": { environmentId: SELF_ID, label: "Desk" },
    "http://100.64.0.3:3773/.well-known/t3/environment": "hang",
  };
  const layer = layerTailnet({
    probed,
    answer: (url) => answers[url],
    peers: [
      node({ name: "laptop", tailnetIpv4Address: "100.64.0.2" }),
      node({ name: "router", tailnetIpv4Address: "100.64.0.3" }),
      node({ name: "offline", tailnetIpv4Address: "100.64.0.4", online: false }),
      node({ name: "ci", tailnetIpv4Address: "100.64.0.5", login: null, tagged: true }),
      node({ name: "friend", tailnetIpv4Address: "100.64.0.6", login: "friend@example.com" }),
      node({ name: "guest", tailnetIpv4Address: "100.64.0.7", shared: true }),
    ],
  });
  return Effect.gen(function* () {
    const service = yield* TailnetConnect.TailnetConnect;
    // Unanswered probes end at their timeout instead of holding the page.
    const fiber = yield* service.listEnvironments(fromPeer("100.64.0.9")).pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    const page = yield* Fiber.join(fiber);

    assert.deepEqual(
      page.environments.map((entry) => [entry.label, entry.pairUrl, entry.current]),
      [
        ["Desk", "/tailnet/pair", true],
        ["WSL", "http://100.64.0.1:3773/tailnet/pair", false],
        ["Laptop", "http://100.64.0.2:3773/tailnet/pair", false],
      ],
    );
    assert.deepEqual(probed.toSorted(), [
      "http://100.64.0.1:3773/.well-known/t3/environment",
      "http://100.64.0.2:3773/.well-known/t3/environment",
      "http://100.64.0.2:3774/.well-known/t3/environment",
      "http://100.64.0.3:3773/.well-known/t3/environment",
      "http://100.64.0.3:3774/.well-known/t3/environment",
    ]);
  }).pipe(Effect.provide(layer));
});
