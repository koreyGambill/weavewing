import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deviceScopes, joinsTrusted, planConnect } from "./connectPlan.logic";
import { buildReachModel, type ReachServerInput, serverPartyId } from "./reachModel.logic";

const WSL = EnvironmentId.make("plan-wsl");
const MAC = EnvironmentId.make("plan-mac");
const RIG = EnvironmentId.make("plan-rig");
const BOX = EnvironmentId.make("plan-box");

const server = (
  overrides: Partial<ReachServerInput> & Pick<ReachServerInput, "environmentId" | "label">,
): ReachServerInput => ({
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
});

const fullLink = (to: EnvironmentId, label: string): PeerLinkSummary => ({
  environmentId: to,
  label,
  urls: ["http://100.64.0.2:3773"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(10_000),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

const model = buildReachModel({
  servers: [
    server({ environmentId: WSL, label: "WSL", links: [] }),
    server({ environmentId: MAC, label: "Mac mini", canManage: false }),
    server({ environmentId: BOX, label: "build-box", route: "ssh", reachableFromOthers: false }),
    server({ environmentId: RIG, label: "gpu-rig", links: [fullLink(WSL, "WSL")] }),
  ],
});
const party = (id: EnvironmentId) =>
  model.columns.find((column) => column.id === serverPartyId(id))!;

describe("planConnect", () => {
  it("makes one line per direction, skips what already holds, and says why a line cannot be made", () => {
    const lines = planConnect(model, party(RIG), {
      uses: [party(WSL), party(MAC), party(BOX)],
      usesLevel: "full-access",
      usedBy: [party(WSL)],
      usedByLevel: "full-access",
    });

    expect(
      lines.map((line) => [line.square.from.label, line.square.to.label, line.blocked]),
    ).toEqual([
      ["gpu-rig", "Mac mini", "Set on Mac mini"],
      ["gpu-rig", "build-box", "No path: build-box has no address gpu-rig can reach"],
      ["WSL", "gpu-rig", null],
    ]);
  });
});

describe("joinsTrusted", () => {
  it("holds only for Full access both ways with the same servers, when every line can be made", () => {
    const both = {
      uses: [party(WSL)],
      usesLevel: "full-access",
      usedBy: [party(WSL)],
      usedByLevel: "full-access",
    } as const;
    expect(joinsTrusted(both, planConnect(model, party(RIG), both))).toBe(true);
    expect(joinsTrusted({ ...both, usedByLevel: "approval-required" }, [])).toBe(false);
    expect(joinsTrusted({ ...both, usedBy: [] }, [])).toBe(false);
    const withBox = { ...both, uses: [party(BOX)], usedBy: [party(BOX)] };
    expect(joinsTrusted(withBox, planConnect(model, party(RIG), withBox))).toBe(false);
  });
});

describe("deviceScopes", () => {
  it("gives a view-only device no way to change things, and never more than this app holds", () => {
    expect(deviceScopes("read-only", [...AuthStandardClientScopes])).not.toContain(
      AuthOrchestrationOperateScope,
    );
    expect(deviceScopes("full-access", [...AuthStandardClientScopes])).toContain(
      AuthAccessWriteScope,
    );
    expect(deviceScopes("full-access", [AuthOrchestrationReadScope])).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });
});
