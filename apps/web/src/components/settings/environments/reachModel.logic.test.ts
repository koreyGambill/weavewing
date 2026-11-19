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
  incomingSquares,
  isRaise,
  planSquareChange,
  type ReachServerInput,
  serverPartyId,
  squareKey,
} from "./reachModel.logic";

const WSL = EnvironmentId.make("env-wsl");
const WINDOWS = EnvironmentId.make("env-windows");
const MOON = EnvironmentId.make("env-moon");
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
    client: { deviceType: "mobile", label: "Korey iPhone", ipAddress: "100.101.1.2" },
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
          environmentId: MOON,
          label: "Moonborn",
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
    expect(state(model, serverPartyId(WINDOWS), MOON).state).toEqual({
      kind: "level",
      level: "can-change",
      broken: null,
    });
    expect(state(model, serverPartyId(WINDOWS), MOON).arrivedVia).toBe("same-computer");
  });

  it("marks a square unknown when this app can read neither side, and says which", () => {
    const model = buildReachModel({
      servers: [
        server({ environmentId: WSL, label: "WSL", links: null }),
        server({ environmentId: MOON, label: "Moonborn", sessions: null, canManage: false }),
      ],
    });

    expect(state(model, serverPartyId(WSL), MOON).state).toEqual({
      kind: "unknown",
      reason: "This app cannot read the links on WSL or who uses Moonborn.",
    });
    expect(state(model, serverPartyId(WSL), MOON).changes.lockedReason).toBe("Set on Moonborn");
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

  it("groups a device's sessions across servers by its name and reads its level from its permissions", () => {
    const model = buildReachModel({
      servers: [
        server({ environmentId: WSL, label: "WSL", sessions: [session({ subject: "browser" })] }),
        server({
          environmentId: MOON,
          label: "Moonborn",
          sessions: [session({ subject: "browser", scopes: [AuthOrchestrationReadScope] })],
        }),
        server({ environmentId: VPS, label: "vps", sessions: null }),
      ],
    });

    const phone = model.rows.find((row) => row.label === "Korey iPhone")!;
    expect(phone.kind).toBe("device");
    expect(model.rows.filter((row) => row.label === "Korey iPhone")).toHaveLength(1);
    expect(state(model, phone.id, WSL).state).toMatchObject({ level: "full-access" });
    expect(state(model, phone.id, WSL).arrivedVia).toBe("tailscale");
    expect(state(model, phone.id, MOON).state).toMatchObject({ level: "read-only" });
    expect(state(model, phone.id, VPS).state.kind).toBe("unknown");
    expect(state(model, phone.id, WSL).changes).toMatchObject({
      canRemove: true,
      canRelink: false,
    });
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
            linkSession(MOON, "Moonborn"),
          ],
        }),
        server({ environmentId: MOON, label: "Moonborn" }),
      ],
    });

    expect(model.rows.map((row) => row.label)).toEqual(["WSL", "Moonborn", "This app"]);
    expect(state(model, APP_PARTY_ID, WSL).state).toMatchObject({ level: "full-access" });
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
          links: [link(MOON, "Moonborn")],
        }),
        server({
          environmentId: MOON,
          label: "Moonborn",
          links: [link(WSL, "WSL")],
          canManage: false,
        }),
        server({ environmentId: VPS, label: "vps", linksOffered: false }),
      ],
    });

    const wslToMoon = state(model, serverPartyId(WSL), MOON).changes;
    expect(wslToMoon).toMatchObject({
      lockedReason: "Set on Moonborn",
      canRelink: false,
      canRemove: true,
      ownOutbound: true,
    });
    expect([...model.manageable]).toEqual([serverPartyId(WSL), serverPartyId(VPS)]);
    const moonToWsl = state(model, serverPartyId(MOON), WSL).changes;
    expect(moonToWsl).toMatchObject({
      lockedReason: null,
      canRelink: false,
      relinkBlockedReason: "Changing the level needs this app to manage Moonborn too",
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
          links: [full(WINDOWS, "Windows"), full(MOON, "Moonborn")],
        }),
        server({
          environmentId: WINDOWS,
          label: "Windows",
          links: [full(WSL, "WSL"), full(MOON, "Moonborn")],
        }),
        server({
          environmentId: MOON,
          label: "Moonborn",
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
    ).toEqual(["Moonborn+WSL", "WSL+Windows"]);
  });

  it("collects each server's outbound links, including to servers this app lacks", () => {
    const model = buildReachModel({
      servers: [server({ environmentId: WSL, label: "WSL", links: [link(VPS, "vps")] })],
    });

    expect(model.outgoing.get(WSL)?.map((entry) => entry.target.label)).toEqual(["vps"]);
    expect(incomingSquares(model, model.columns[0]!).map((square) => square.from.label)).toEqual([
      "This app",
    ]);
  });
});

describe("an unreachable server", () => {
  it("keeps its last known lines but offers no changes and says it is not answering", () => {
    const model = buildReachModel({
      servers: [
        server({ environmentId: WSL, label: "WSL", links: [link(MOON, "Moonborn")] }),
        server({
          environmentId: MOON,
          label: "Moonborn",
          appScopes: null,
          sessions: [linkSession(WSL, "WSL"), session({ subject: "browser" })],
        }),
      ],
    });

    const intoMoon = state(model, serverPartyId(WSL), MOON);
    expect(intoMoon.state).toMatchObject({ level: "full-access" });
    expect(intoMoon.changes).toMatchObject({
      lockedReason: "Moonborn is not answering",
      canRelink: false,
    });
    const phone = model.rows.find((row) => row.label === "Korey iPhone")!;
    expect(state(model, phone.id, MOON).changes.canRemove).toBe(false);
    expect(model.manageable.has(serverPartyId(MOON))).toBe(false);
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
        links: [link(MOON, "Moonborn", { access: "approval-required" })],
      }),
      server({
        environmentId: MOON,
        label: "Moonborn",
        links: [link(WSL, "WSL", { access: "full-access", status: "expired" })],
      }),
    ],
  });
  const outbound = state(model, serverPartyId(WSL), MOON);
  const inbound = state(model, serverPartyId(MOON), WSL);

  it("previews a raise before it happens", () => {
    expect(planSquareChange(outbound, "full-access")).toEqual({
      kind: "confirm",
      action: "relink",
      target: "full-access",
      sentence:
        "WSL gets Full access on Moonborn. Moonborn issues a new code and WSL links again with it.",
    });
  });

  it("asks before this computer lowers or gives up its own access elsewhere", () => {
    expect(planSquareChange(outbound, "read-only")).toMatchObject({
      kind: "confirm",
      sentence:
        "WSL drops to View only on Moonborn. Getting it back needs approval on Moonborn, or SSH.",
    });
    expect(planSquareChange(outbound, "none")).toMatchObject({
      kind: "confirm",
      action: "remove",
      sentence:
        "WSL gives up its access to Moonborn. Getting it back needs approval on Moonborn, or SSH.",
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
    const square = phone.squares.get(squareKey("device:korey iphone", serverPartyId(WSL)))!;
    expect(planSquareChange(square, "read-only")).toEqual({
      kind: "blocked",
      reason: "A device keeps the level it paired with. Pair it again to change it.",
    });
  });
});
