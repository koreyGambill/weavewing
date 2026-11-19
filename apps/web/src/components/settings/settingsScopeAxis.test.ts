import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeCheckoutChoices,
  settingsScopeCheckoutLabel,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

const member = (environmentId: string, physicalProjectKey: string, workspaceRoot = "") =>
  ({
    environmentId,
    physicalProjectKey,
    workspaceRoot,
  }) as SidebarProjectSnapshot["memberProjects"][number];
const group = (...memberProjects: SidebarProjectSnapshot["memberProjects"]) =>
  ({ memberProjects }) as SidebarProjectSnapshot;

const sshBuild = (environmentId: string, port: number | null) =>
  ({
    environmentId,
    label: "Build",
    displayUrl: "dev@gateway.example.com",
    entry: {
      target: { _tag: "SshConnectionTarget" },
      profile: Option.some({
        _tag: "SshConnectionProfile",
        target: { alias: "gw", hostname: "gateway.example.com", username: "dev", port },
      }),
    },
  }) as unknown as Parameters<typeof settingsScopeEnvironmentLabel>[0];

describe("settings scope axes", () => {
  it("widens same-named machine labels until each one is unique", () => {
    const first = sshBuild("env-aaaa-11111111", 2222);
    const second = sshBuild("env-bbbb-22222222", 2223);
    expect(
      [first, second].map((env) => settingsScopeEnvironmentLabel(env, [first, second])),
    ).toEqual(["Build · dev@gateway.example.com:2222", "Build · dev@gateway.example.com:2223"]);
    const samePort = sshBuild("env-cccc-33333333", 2222);
    expect(settingsScopeEnvironmentLabel(samePort, [first, samePort])).toBe(
      "Build · dev@gateway.example.com:2222 · 33333333",
    );
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });

  it("offers checkouts only where an environment cannot tell them apart", () => {
    const a = member("laptop", "a");
    const b = member("laptop", "b");
    const c = member("server", "c");

    expect(settingsScopeCheckoutChoices(group(a, b, c), { machine: "laptop" })).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b), {})).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), { checkout: "b" })).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), {})).toEqual([]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), { machine: "server" })).toEqual([]);
  });

  it("labels a checkout by its full path only when its folder name repeats", () => {
    const first = member("laptop", "a", "/work/one/app");
    const second = member("laptop", "b", "C:\\work\\two\\app");
    const other = member("laptop", "c", "/work/tools");

    expect(settingsScopeCheckoutLabel(second, [first, second, other])).toBe("C:\\work\\two\\app");
    expect(settingsScopeCheckoutLabel(other, [first, second, other])).toBe("tools");
  });
});
