import { type DesktopWslState, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  connectDeviceName,
  describeConnectDeviceClient,
  isServerNetworkAccessible,
  formatDesktopSshConnectionError,
  parseManualDesktopSshTarget,
  resolveAccessEnvironmentId,
  resolveTailscaleServeBaseUrl,
  selectQrEndpointOption,
  selectPairingEndpoint,
  serverPairingEndpoints,
  resolveAdvertisedEndpointPairingUrl,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

it.each([
  {
    label: "WSL with Tailscale",
    desktopLocal: true,
    hasTailnet: true,
    expected: ["private-network"],
  },
  { label: "WSL without Tailscale", desktopLocal: true, hasTailnet: false, expected: [] },
  {
    label: "remote environment",
    desktopLocal: false,
    hasTailnet: true,
    expected: ["lan", "lan", "private-network"],
  },
  {
    label: "remote environment without Tailscale",
    desktopLocal: false,
    hasTailnet: false,
    expected: ["lan", "lan"],
  },
] as const)("builds pairing routes for $label", ({ desktopLocal, hasTailnet, expected }) => {
  const directEndpoints = [
    { kind: "lan", httpBaseUrl: "http://172.30.64.1:3774/" },
    { kind: "lan", httpBaseUrl: "http://192.168.1.42:3774/" },
    { kind: "tailnet", httpBaseUrl: "http://100.84.12.7:3774/" },
  ] as const;
  const endpoints = serverPairingEndpoints(
    directEndpoints.filter((endpoint) => hasTailnet || endpoint.kind !== "tailnet"),
    desktopLocal,
  );
  expect(endpoints.map((endpoint) => endpoint.reachability)).toEqual(expected);
  const selected = selectPairingEndpoint(endpoints);
  if (expected.length === 0) {
    expect(selected).toBeNull();
  } else if (desktopLocal) {
    expect(resolveAdvertisedEndpointPairingUrl(selected!, "test-token")).toBe(
      "http://100.84.12.7:3774/pair#token=test-token",
    );
    expect(selected?.compatibility.hostedHttpsApp).toBe("mixed-content-blocked");
  }
  expect(serverPairingEndpoints([], desktopLocal)).toEqual([]);
});

describe("session client labels", () => {
  it("names stored desktop and web sessions by this app's brand", () => {
    expect(connectDeviceName({ client: { label: "T3 Code Desktop", deviceType: "desktop" } })).toBe(
      "Weavewing Desktop",
    );
    expect(
      describeConnectDeviceClient({
        client: { label: "T3 Code Web", deviceType: "desktop", os: "macOS" },
      }),
    ).toBe("Weavewing Web · macOS");
  });

  it("shows any other label as the device sent it", () => {
    expect(connectDeviceName({ client: { label: "Pixel 9", deviceType: "mobile" } })).toBe(
      "Pixel 9",
    );
  });
});

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

describe("parseManualDesktopSshTarget", () => {
  it.each(["22.5", "1e3", "2222garbage"])("rejects explicit port %j", (port) => {
    expect(() => parseManualDesktopSshTarget({ host: "devbox", username: "", port })).toThrow(
      "SSH port must be between 1 and 65535.",
    );
  });
});

describe("formatDesktopSshConnectionError", () => {
  const download = (curl: string) =>
    new Error(
      `Could not prepare the SSH environment: Error invoking remote method 'desktop:ensure-ssh-environment': SshCommandError: ${curl}\nCould not download t3 0.1.9 from https://github.com/koreyGambill/weavewing/releases/download/weavewing-v0.1.9/SHA256SUMS. If this host cannot reach it, install t3 0.1.9 from https://github.com/koreyGambill/weavewing/releases.\nNo running T3 Code desktop app was found in /Users/me/.t3 to connect to instead. Open the app on this host and retry.`,
    );
  it.each([
    [
      "a version with no published server",
      download("curl: (56) The requested URL returned error: 404"),
      "This build of Weavewing (0.1.9) has no published server to install over SSH, and no running Weavewing was found on that computer. Open Weavewing there and retry, or connect with a link and code.",
    ],
    [
      "a host that cannot reach the download",
      download("curl: (6) Could not resolve host: github.com"),
      "That computer could not download Weavewing 0.1.9, and no running Weavewing was found there. Open Weavewing there and retry, or connect with a link and code.",
    ],
    [
      "any other failure, without the bridge's prefixes",
      new Error(
        "Error invoking remote method 'desktop:ensure-ssh-environment': SshCommandError: Permission denied",
      ),
      "Permission denied",
    ],
  ] as const)("explains %s", (_name, error, expected) => {
    expect(formatDesktopSshConnectionError(error)).toBe(expected);
  });
});

describe("resolveTailscaleServeBaseUrl", () => {
  it.each([
    ["https://host.tail.ts.net:441/", 443, "https://host.tail.ts.net"],
    ["https://host.tail.ts.net:441/", 444, "https://host.tail.ts.net:444"],
  ] as const)("previews %s on port %i", (httpBaseUrl, port, expected) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, true)).toBe(expected);
  });

  it("returns null without a pending endpoint", () => {
    expect(resolveTailscaleServeBaseUrl(null, 443, true)).toBeNull();
  });

  it.each([
    ["https://host.tail.ts.net:441/", 0, false],
    ["not a URL", 443, true],
  ] as const)("preserves %s when port %i cannot be previewed", (httpBaseUrl, port, isPortValid) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, isPortValid)).toBe(httpBaseUrl);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});

describe("resolveAccessEnvironmentId", () => {
  const primary = EnvironmentId.make("primary");
  const service = EnvironmentId.make("service");
  const laptop = EnvironmentId.make("laptop");
  it.each([
    {
      label: "defaults to the primary environment",
      primaryEnvironmentId: primary,
      environments: [
        { environmentId: primary, connected: true },
        { environmentId: service, connected: true },
      ],
      selected: null,
      expected: primary,
    },
    {
      label: "falls back to a connected saved environment without a primary",
      primaryEnvironmentId: null,
      environments: [
        { environmentId: laptop, connected: false },
        { environmentId: service, connected: true },
      ],
      selected: null,
      expected: service,
    },
    {
      label: "keeps an explicit choice",
      primaryEnvironmentId: primary,
      environments: [
        { environmentId: primary, connected: true },
        { environmentId: laptop, connected: false },
      ],
      selected: laptop,
      expected: laptop,
    },
    {
      label: "drops a choice that is no longer listed",
      primaryEnvironmentId: null,
      environments: [{ environmentId: service, connected: true }],
      selected: laptop,
      expected: service,
    },
    {
      label: "has nothing to show without environments",
      primaryEnvironmentId: null,
      environments: [],
      selected: null,
      expected: null,
    },
  ])("$label", ({ primaryEnvironmentId, environments, selected, expected }) => {
    expect(resolveAccessEnvironmentId({ primaryEnvironmentId, environments, selected })).toBe(
      expected,
    );
  });
});

describe("isServerNetworkAccessible", () => {
  const served = [{ kind: "tailnet", httpBaseUrl: "https://host.example.ts.net:8443/" }] as const;
  it.each([
    { authPolicy: "remote-reachable", directEndpoints: undefined, expected: true },
    { authPolicy: "loopback-browser", directEndpoints: undefined, expected: false },
    { authPolicy: "loopback-browser", directEndpoints: [], expected: false },
    { authPolicy: "loopback-browser", directEndpoints: served, expected: true },
    { authPolicy: null, directEndpoints: served, expected: false },
  ] as const)("$authPolicy with $directEndpoints.length endpoints", (row) => {
    expect(isServerNetworkAccessible(row)).toBe(row.expected);
  });
});
