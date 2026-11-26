import {
  type AuthClientSession,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  APP_PARTY_ID,
  arrivalFromHost,
  buildReachModel,
  describeDevice,
  accessHolders,
  deviceParties,
  isRaise,
  planSquareChange,
  type ReachServerInput,
  serverPartyId,
  squareKey,
} from "./reachModel.logic";

const WSL = EnvironmentId.make("env-wsl");
const WINDOWS = EnvironmentId.make("env-windows");
const MAC = EnvironmentId.make("env-mac");
const BUILD = EnvironmentId.make("env-build");
const VPS = EnvironmentId.make("env-vps");

const FULL_LINK_SCOPES: AuthEnvironmentScope[] = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
];

function server(
  overrides: Partial<ReachServerInput> & Pick<ReachServerInput, "environmentId" | "label">,
): ReachServerInput {
  return {
    onThisComputer: false,
    sharesHostLoopback: false,
    route: "direct",
    routeUrl: null,
    reachableFromOthers: true,
    linksOffered: true,
    canManage: true,
    appScopes: [...AuthStandardClientScopes],
    sessions: [],
    links: [],
    ...overrides,
  };
}

let sessionCounter = 0;
function session(
  overrides: Partial<AuthClientSession> & Pick<AuthClientSession, "subject">,
): AuthClientSession {
  sessionCounter += 1;
  return {
    sessionId: AuthSessionId.make(`session-${sessionCounter}`),
    scopes: [...AuthStandardClientScopes],
    method: "bearer-access-token",
    client: { deviceType: "mobile", label: "Work phone", ipAddress: "100.101.1.2" },
    issuedAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(10_000),
    lastConnectedAt: null,
    connected: true,
    current: false,
    ...overrides,
  };
}

const linkSession = (from: EnvironmentId, label: string, scopes = FULL_LINK_SCOPES) =>
  session({
    subject: `mcp-peer-link:${from}`,
    scopes,
    client: { deviceType: "bot", label: `Linked environment · ${label}`, ipAddress: "127.0.0.1" },
  });

function link(
  to: EnvironmentId,
  label: string,
  overrides: Partial<PeerLinkSummary> = {},
): PeerLinkSummary {
  return {
    environmentId: to,
    label,
    urls: ["http://127.0.0.1:3773"],
    access: "full-access",
    linkedAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(10_000),
    lastReachedAt: null,
    lastError: null,
    status: "reachable",
    ...overrides,
  };
}

const state = (model: ReturnType<typeof buildReachModel>, from: string, to: EnvironmentId) =>
  model.squares.get(squareKey(from, serverPartyId(to)))!;

describe("buildReachModel", () => {
  it("reads a link's exact level from the linking side and falls back to the receiving side's scopes", () => {
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WSL,
          label: "WSL",
          onThisComputer: true,
          links: [link(WINDOWS, "Windows", { access: "auto" })],
        }),
        server({
          environmentId: WINDOWS,
          label: "Windows",
          onThisComputer: true,
          links: null,
          sessions: [linkSession(WSL, "WSL")],
        }),
        server({
          environmentId: MAC,
          label: "Mac mini",
          sessions: [
            linkSession(WINDOWS, "Windows", [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]),
          ],
        }),
      ],
    });

    expect(state(model, serverPartyId(WSL), WINDOWS).state).toEqual({
      kind: "level",
      level: "auto",
      broken: null,
    });
    expect(state(model, serverPartyId(WINDOWS), MAC).state).toEqual({
      kind: "level",
      level: "can-change",
      broken: null,
    });
    expect(state(model, serverPartyId(WINDOWS), MAC).arrivedVia).toBeNull();
  });

  it("marks a square unknown when this app can read neither side, and says which", () => {
    const model = buildReachModel({
      servers: [
        server({ environmentId: WSL, label: "WSL", links: null }),
        server({ environmentId: MAC, label: "Mac mini", sessions: null, canManage: false }),
      ],
    });

    expect(state(model, serverPartyId(WSL), MAC).state).toEqual({
      kind: "unknown",
      reason: "This app cannot read the links on WSL or who uses Mac mini.",
    });
    expect(state(model, serverPartyId(WSL), MAC).changes.lockedReason).toBe("Set on Mac mini");
  });

  it("shows no path to a server nothing else can reach, except between servers sharing this computer's loopback", () => {
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WINDOWS,
          label: "Windows",
          onThisComputer: true,
          sharesHostLoopback: true,
          reachableFromOthers: false,
        }),
        server({
          environmentId: WSL,
          label: "WSL",
          onThisComputer: true,
          sharesHostLoopback: true,
          reachableFromOthers: false,
        }),
        server({
          environmentId: BUILD,
          label: "build-box",
          route: "ssh",
          reachableFromOthers: false,
        }),
      ],
    });

    expect(state(model, serverPartyId(WSL), WINDOWS).state.kind).toBe("none");
    expect(state(model, serverPartyId(WSL), WINDOWS).changes.canRelink).toBe(true);
    expect(state(model, serverPartyId(WSL), BUILD).state.kind).toBe("no-path");
    expect(state(model, serverPartyId(WSL), BUILD).changes.canRelink).toBe(false);
    expect(state(model, serverPartyId(BUILD), WINDOWS).state.kind).toBe("no-path");
    expect(state(model, APP_PARTY_ID, BUILD).arrivedVia).toBe("ssh");
  });

  it("keeps every device session its own entry, so one Remove revokes exactly one session", () => {
    const chrome = (ipAddress: string) =>
      session({
        subject: "browser",
        client: { deviceType: "desktop", label: "Chrome on Linux", ipAddress },
      });
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WSL,
          label: "WSL",
          sessions: [chrome("192.168.1.5"), chrome("192.168.1.6"), session({ subject: "browser" })],
        }),
        server({
          environmentId: MAC,
          label: "Mac mini",
          sessions: [session({ subject: "browser", scopes: [AuthOrchestrationReadScope] })],
        }),
        server({ environmentId: VPS, label: "vps", sessions: null }),
      ],
    });

    const devices = model.rows.filter((row) => row.kind === "device");
    expect(devices.map((row) => row.label)).toEqual([
      "Chrome on Linux · 192.168.1.5",
      "Chrome on Linux · 192.168.1.6",
      "Work phone · Mac mini",
      "Work phone · WSL",
    ]);
    for (const device of devices) {
      const removable = model.columns.flatMap((column) => {
        const square = model.squares.get(squareKey(device.id, column.id))!;
        return square.changes.canRemove ? [square.sessionIds] : [];
      });
      expect(removable).toHaveLength(1);
      expect(removable[0]).toHaveLength(1);
    }
    const phoneOnMac = devices.find((row) => row.label === "Work phone · Mac mini")!;
    expect(state(model, phoneOnMac.id, MAC).state).toMatchObject({ level: "read-only" });
    expect(state(model, phoneOnMac.id, MAC).arrivedVia).toBe("tailscale");
    expect(state(model, phoneOnMac.id, WSL).state.kind).toBe("none");
    expect(state(model, phoneOnMac.id, VPS).state.kind).toBe("unknown");
    expect(state(model, phoneOnMac.id, MAC).changes).toMatchObject({ canRelink: false });
  });

  it("keeps this app and link sessions out of the devices", () => {
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WSL,
          label: "WSL",
          sessions: [
            session({
              subject: "desktop",
              current: true,
              client: { deviceType: "desktop", label: "This PC" },
            }),
            linkSession(MAC, "Mac mini"),
          ],
        }),
        server({ environmentId: MAC, label: "Mac mini" }),
      ],
    });

    expect(model.rows.map((row) => row.label)).toEqual(["WSL", "Mac mini", "This app"]);
    expect(state(model, APP_PARTY_ID, WSL).state).toMatchObject({ level: "full-access" });
    expect(deviceParties(model)).toEqual([]);
    expect(
      accessHolders(
        model,
        model.columns.find((column) => column.environmentId === WSL)!,
      ),
    ).toEqual([]);
  });

  it("lists a server that links in but this app does not know as a row only", () => {
    const model = buildReachModel({
      servers: [server({ environmentId: WSL, label: "WSL", sessions: [linkSession(VPS, "vps")] })],
    });

    expect(model.columns.map((column) => column.label)).toEqual(["WSL"]);
    expect(model.rows.map((row) => row.label)).toEqual(["WSL", "vps", "This app"]);
    expect(state(model, serverPartyId(VPS), WSL).state).toMatchObject({ level: "full-access" });
    expect(state(model, serverPartyId(VPS), WSL).changes.canRemove).toBe(true);
  });

  it("allows a level change only when this app manages both ends and both offer links", () => {
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WSL,
          label: "WSL",
          onThisComputer: true,
          links: [link(MAC, "Mac mini")],
        }),
        server({
          environmentId: MAC,
          label: "Mac mini",
          links: [link(WSL, "WSL")],
          canManage: false,
        }),
        server({ environmentId: VPS, label: "vps", linksOffered: false }),
      ],
    });

    const wslToMac = state(model, serverPartyId(WSL), MAC).changes;
    expect(wslToMac).toMatchObject({
      lockedReason: "Set on Mac mini",
      canRelink: false,
      canRemove: true,
      ownOutbound: true,
    });
    expect([...model.manageable]).toEqual([serverPartyId(WSL), serverPartyId(VPS)]);
    const macToWsl = state(model, serverPartyId(MAC), WSL).changes;
    expect(macToWsl).toMatchObject({
      lockedReason: null,
      canRelink: false,
      relinkBlockedReason: "Changing the level needs this app to manage Mac mini too",
      ownOutbound: false,
    });
    expect(state(model, serverPartyId(WSL), VPS).changes.relinkBlockedReason).toBe(
      "Linked environments is off on one of them (Settings → Labs)",
    );
  });

  it("derives trusted groups from Full access both ways, ignoring broken links", () => {
    const full = (to: EnvironmentId, label: string) => link(to, label);
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WSL,
          label: "WSL",
          links: [full(WINDOWS, "Windows"), full(MAC, "Mac mini")],
        }),
        server({
          environmentId: WINDOWS,
          label: "Windows",
          links: [full(WSL, "WSL"), full(MAC, "Mac mini")],
        }),
        server({
          environmentId: MAC,
          label: "Mac mini",
          links: [full(WSL, "WSL"), link(WINDOWS, "Windows", { status: "expired" })],
        }),
      ],
    });

    expect(
      model.trusted
        .map((group) =>
          group
            .map((party) => party.label)
            .toSorted()
            .join("+"),
        )
        .toSorted(),
    ).toEqual(["Mac mini+WSL", "WSL+Windows"]);
  });
});

describe("links to a server this app is not connected to", () => {
  const withLink = (links: ReadonlyArray<PeerLinkSummary>, vpsLinksIn = false) =>
    buildReachModel({
      servers: [
        server({
          environmentId: WSL,
          label: "WSL",
          links,
          sessions: vpsLinksIn ? [linkSession(VPS, "vps")] : [],
        }),
        server({ environmentId: MAC, label: "Mac mini" }),
      ],
    });

  it("shows the link target as a locked column with the linking side's exact level and ? elsewhere", () => {
    const model = withLink([link(VPS, "vps", { access: "approval-required" })]);
    const vps = serverPartyId(VPS);

    expect(model.columns.map((column) => column.label)).toEqual(["WSL", "Mac mini", "vps"]);
    expect(model.rows.map((row) => row.label)).not.toContain("vps");
    expect(model.unconnected).toEqual(new Set([vps]));
    expect(model.manageable.has(vps)).toBe(false);
    expect(state(model, serverPartyId(WSL), VPS)).toMatchObject({
      state: { kind: "level", level: "approval-required", broken: null },
      changes: { lockedReason: "vps is not connected to this app", canRemove: true },
    });
    for (const from of [serverPartyId(MAC), APP_PARTY_ID]) {
      expect(state(model, from, VPS).state).toEqual({
        kind: "unknown",
        reason: "vps is not connected to this app, so it cannot read who uses it.",
      });
    }
  });

  it("gives the link up only after asking, renews nothing from here, and drops the column once gone", () => {
    const model = withLink([link(VPS, "vps", { status: "expired" })]);
    const square = state(model, serverPartyId(WSL), VPS);

    expect(planSquareChange(square, "none")).toMatchObject({
      kind: "confirm",
      action: "remove",
      sentence: "WSL gives up its access to vps. Getting it back needs approval on vps, or SSH.",
    });
    expect(planSquareChange(square, "full-access")).toEqual({
      kind: "blocked",
      reason: "Renewing needs a new code from vps, which this app is not connected to",
    });
    expect(withLink([]).columns.map((column) => column.label)).toEqual(["WSL", "Mac mini"]);
  });

  it("never counts the link target as trusted, even when it links back in with full access", () => {
    const model = withLink([link(VPS, "vps")], true);

    expect(state(model, serverPartyId(VPS), WSL).state).toMatchObject({ level: "full-access" });
    expect(state(model, serverPartyId(WSL), VPS).state).toMatchObject({ level: "full-access" });
    expect(model.trusted).toEqual([]);
  });
});

describe("T3 Connect sessions", () => {
  it("never become a device, a line, a square or something to revoke here", () => {
    const connect = session({
      subject: "cloud-connect",
      client: { deviceType: "mobile", label: "Connect phone", ipAddress: "127.0.0.1" },
    });
    const model = buildReachModel({
      servers: [server({ environmentId: WSL, label: "WSL", sessions: [connect] })],
    });

    expect(model.rows.map((row) => row.label)).toEqual(["WSL", "This app"]);
    expect(accessHolders(model, model.columns[0]!)).toEqual([]);
    expect([...model.squares.values()].flatMap((square) => square.sessionIds)).not.toContain(
      connect.sessionId,
    );
  });
});

describe("arrival tags", () => {
  it("reads each line's tag from the address it uses and keeps that address", () => {
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WSL,
          label: "WSL",
          links: [
            link(WINDOWS, "Windows", { urls: ["http://localhost:6925"] }),
            link(MAC, "Mac mini", { urls: ["http://100.67.211.34:14990"] }),
          ],
        }),
        server({ environmentId: WINDOWS, label: "Windows" }),
        server({
          environmentId: MAC,
          label: "Mac mini",
          sessions: [
            session({
              subject: "browser",
              client: { deviceType: "mobile", label: "Phone", ipAddress: "100.101.1.2" },
            }),
            session({
              subject: "browser",
              client: { deviceType: "desktop", label: "Laptop", ipAddress: "192.168.68.20" },
            }),
          ],
        }),
      ],
    });
    const device = (label: string) => model.rows.find((row) => row.label === label)!.id;

    expect(state(model, serverPartyId(WSL), WINDOWS)).toMatchObject({
      arrivedVia: "same-computer",
      arrivedFrom: "http://localhost:6925",
    });
    expect(state(model, serverPartyId(WSL), MAC)).toMatchObject({
      arrivedVia: "tailscale",
      arrivedFrom: "http://100.67.211.34:14990",
    });
    expect(state(model, device("Phone"), MAC).arrivedVia).toBe("tailscale");
    expect(state(model, device("Laptop"), MAC).arrivedVia).toBe("local-network");
  });

  // A Windows server behind Tailscale Serve stores a phone, a Mac and a WSL link all at 127.0.0.1,
  // the same address a browser on that PC records, so loopback proves nothing.
  it("tags only from session evidence: a sibling server or this app, a tailnet or LAN address, never loopback", () => {
    const device = (label: string, ipAddress: string, deviceType: "mobile" | "desktop") =>
      session({
        subject: "one-time-token",
        connected: false,
        lastConnectedAt: DateTime.makeUnsafe(0),
        client: { deviceType, label, ipAddress, ...(deviceType === "mobile" ? { os: "iOS" } : {}) },
      });
    const tailnetPaired = device("Tailnet: iphone171", "127.0.0.1", "mobile");
    const model = buildReachModel({
      servers: [
        server({
          environmentId: WINDOWS,
          label: "Windows",
          onThisComputer: true,
          route: "local",
          links: null,
          sessions: [
            device("Pixel 8", "127.0.0.1", "mobile"),
            device("Chrome on Windows", "127.0.0.1", "desktop"),
            device("Mac mini", "100.101.1.2", "desktop"),
            device("Laptop", "192.168.68.20", "desktop"),
            linkSession(WSL, "WSL"),
          ],
        }),
        server({
          environmentId: WSL,
          label: "WSL",
          onThisComputer: true,
          route: "local",
          links: null,
          sessions: [tailnetPaired],
        }),
        server({
          environmentId: VPS,
          label: "vps",
          links: null,
          sessions: [linkSession(WINDOWS, "Windows")],
        }),
      ],
    });
    const row = (label: string) => model.rows.find((candidate) => candidate.label === label)!.id;
    const tag = (from: string, to: EnvironmentId) => state(model, from, to).arrivedVia;

    expect(tag(row("Pixel 8"), WINDOWS)).toBeNull();
    expect(tag(row("Chrome on Windows"), WINDOWS)).toBeNull();
    expect(tag(row("Tailnet: iphone171"), WSL)).toBeNull();
    expect(describeDevice(tailnetPaired, 0)).toMatch(/^admitted automatically over Tailscale · /);
    expect(tag(row("Mac mini"), WINDOWS)).toBe("tailscale");
    expect(tag(row("Laptop"), WINDOWS)).toBe("local-network");
    expect(tag(serverPartyId(WSL), WINDOWS)).toBe("same-computer");
    expect(tag(serverPartyId(WINDOWS), VPS)).toBeNull();
    expect(tag(APP_PARTY_ID, WINDOWS)).toBe("same-computer");
  });
});

describe("an unreachable server", () => {
  it("keeps its last known lines but offers no changes and says it is not answering", () => {
    const model = buildReachModel({
      servers: [
        server({ environmentId: WSL, label: "WSL", links: [link(MAC, "Mac mini")] }),
        server({
          environmentId: MAC,
          label: "Mac mini",
          appScopes: null,
          sessions: [linkSession(WSL, "WSL"), session({ subject: "browser" })],
        }),
      ],
    });

    const intoMoon = state(model, serverPartyId(WSL), MAC);
    expect(intoMoon.state).toMatchObject({ level: "full-access" });
    expect(intoMoon.changes).toMatchObject({
      lockedReason: "Mac mini is not answering",
      canRelink: false,
    });
    const phone = model.rows.find((row) => row.label === "Work phone")!;
    expect(state(model, phone.id, MAC).changes.canRemove).toBe(false);
    expect(model.manageable.has(serverPartyId(MAC))).toBe(false);
  });
});

describe("describeDevice", () => {
  const HOUR = 3_600_000;
  it.each([
    [
      "a phone admitted by tailnet pairing",
      session({
        subject: "one-time-token",
        connected: false,
        lastConnectedAt: DateTime.makeUnsafe(0),
        client: { deviceType: "mobile", os: "iOS", label: "Tailnet: iphone171" },
      }),
      "admitted automatically over Tailscale · iPhone · last seen 3h ago",
    ],
    [
      "a Mac paired by link",
      session({
        subject: "one-time-token",
        client: { deviceType: "desktop", os: "macOS", browser: "Electron", label: "Mac mini" },
      }),
      "paired by link or code · desktop app on macOS · connected now",
    ],
    [
      "a browser whose name already says what it is",
      session({
        subject: "administrative-bootstrap",
        connected: false,
        lastConnectedAt: null,
        client: { deviceType: "desktop", os: "Windows", browser: "Chrome" },
      }),
      "paired with the server's startup link · never connected",
    ],
  ] as const)("describes %s", (_name, device, expected) => {
    expect(describeDevice(device, 3 * HOUR)).toBe(expected);
  });
});

describe("arrivalFromHost", () => {
  it.each([
    ["127.0.0.1", "same-computer"],
    ["::1", "same-computer"],
    ["100.88.1.2", "tailscale"],
    ["box.tail1234.ts.net", "tailscale"],
    ["192.168.1.20", "local-network"],
    ["172.20.0.4", "local-network"],
    ["8.8.8.8", "internet"],
    ["fd7a:115c:a1e0::1234:5678", "tailscale"],
    ["[FD7A:115C:A1E0:AB12::1]", "tailscale"],
    ["fd12:3456:789a::1", "local-network"],
    // Link-local only reaches the same network segment.
    ["fe80::1c2b:3aff:fe4d:5e6f", "local-network"],
    ["2606:4700::1111", "internet"],
    [null, null],
  ] as const)("%s arrives %s", (host, expected) => {
    expect(arrivalFromHost(host)).toBe(expected);
  });
});

describe("isRaise", () => {
  it("treats a new line or a higher level as a raise", () => {
    expect(isRaise(null, "read-only")).toBe(true);
    expect(isRaise("read-only", "full-access")).toBe(true);
    expect(isRaise("full-access", "approval-required")).toBe(false);
    expect(isRaise("auto", "approval-required")).toBe(false);
  });
});

describe("planSquareChange", () => {
  const model = buildReachModel({
    servers: [
      server({
        environmentId: WSL,
        label: "WSL",
        onThisComputer: true,
        links: [link(MAC, "Mac mini", { access: "approval-required" })],
      }),
      server({
        environmentId: MAC,
        label: "Mac mini",
        links: [link(WSL, "WSL", { access: "full-access", status: "expired" })],
      }),
    ],
  });
  const outbound = state(model, serverPartyId(WSL), MAC);
  const inbound = state(model, serverPartyId(MAC), WSL);

  it("previews a raise before it happens", () => {
    expect(planSquareChange(outbound, "full-access")).toEqual({
      kind: "confirm",
      action: "relink",
      target: "full-access",
      sentence:
        "WSL gets Full access on Mac mini. Mac mini issues a new code and WSL links again with it.",
    });
  });

  it("asks before this computer lowers or gives up its own access elsewhere", () => {
    expect(planSquareChange(outbound, "read-only")).toMatchObject({
      kind: "confirm",
      sentence:
        "WSL drops to View only on Mac mini. Getting it back needs approval on Mac mini, or SSH.",
    });
    expect(planSquareChange(outbound, "none")).toMatchObject({
      kind: "confirm",
      action: "remove",
      sentence:
        "WSL gives up its access to Mac mini. Getting it back needs approval on Mac mini, or SSH.",
    });
  });

  it("lowers someone else's access to a server this app manages at once", () => {
    expect(planSquareChange(inbound, "none")).toEqual({
      kind: "apply",
      action: "remove",
      target: "none",
      sentence: null,
    });
  });

  it("renews an expired link at its own level with a preview", () => {
    expect(planSquareChange(inbound, "full-access")).toMatchObject({
      kind: "confirm",
      action: "relink",
    });
  });

  it("refuses an unchanged level and says why a change is blocked", () => {
    expect(planSquareChange(outbound, "approval-required")).toEqual({
      kind: "blocked",
      reason: "Already Ask before changes",
    });
    const phone = buildReachModel({
      servers: [
        server({ environmentId: WSL, label: "WSL", sessions: [session({ subject: "browser" })] }),
      ],
    });
    const device = phone.rows.find((row) => row.kind === "device")!;
    const square = phone.squares.get(squareKey(device.id, serverPartyId(WSL)))!;
    expect(planSquareChange(square, "read-only")).toEqual({
      kind: "blocked",
      reason: "A device keeps the level it paired with. Pair it again to change it.",
    });
  });
});
