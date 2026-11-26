import {
  compileModsAsync,
  type ExportedConfig,
  IOSConfig,
  type ModPlatform,
  type StaticPlugin,
  withPlugins,
} from "expo/config-plugins";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { MOBILE_APP_VARIANTS, mobileIosProjectName } from "../../scripts/lib/public-config.ts";
import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
const testEnv = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock("../../scripts/lib/public-config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/public-config.ts")>()),
  loadRepoEnv: () => ({ ...testEnv.current }),
}));

const DISTRIBUTION_SETTINGS = {
  T3CODE_APPLE_TEAM_ID: "ABCDE12345",
  T3CODE_EXPO_OWNER: "example-owner",
  T3CODE_EXPO_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
};
// pk_test_ followed by base64 of "clerk.example.com$".
const CLERK_PUBLISHABLE_KEY = `pk_test_${btoa("clerk.example.com$")}`;
const VARIANT_IDENTIFIERS = {
  development: "dev.wingstack.weavewing.mobile.dev",
  preview: "dev.wingstack.weavewing.mobile.preview",
  production: "dev.wingstack.weavewing.mobile",
};

afterEach(() => {
  testEnv.current = {};
});

async function loadConfig(variant: string | undefined, env: Record<string, string> = {}) {
  vi.resetModules();
  testEnv.current = variant === undefined ? env : { APP_VARIANT: variant, ...env };
  return (await import("./app.config.ts")).default();
}

// Applies the config's plugins the way prebuild does and returns the iOS files they would write.
async function introspectIos(config: Awaited<ReturnType<typeof loadConfig>>) {
  const projectRoot = import.meta.dirname;
  const plugins = (config.plugins ?? []).flatMap((entry): Array<string | StaticPlugin> => {
    if (typeof entry === "string") return [entry];
    const [name, props]: readonly unknown[] = entry;
    return typeof name === "string" ? [[name, props]] : [];
  });
  const withMods = withPlugins({ ...config, _internal: { projectRoot } }, plugins);
  const compiled = await compileModsAsync(withMods, {
    projectRoot,
    introspect: true,
    platforms: ["ios"],
    assertMissingModProviders: false,
  });
  return { entitlements: compiled.ios?.entitlements, infoPlist: compiled.ios?.infoPlist };
}

function clerkPluginOptions(config: Awaited<ReturnType<typeof loadConfig>>) {
  const plugin = config.plugins?.find(
    (entry) => Array.isArray(entry) && entry[0] === "@clerk/expo",
  );
  return Array.isArray(plugin) ? plugin[1] : undefined;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, VARIANT_IDENTIFIERS.production, "Weavewing"],
  ["development", VARIANT_IDENTIFIERS.development, "Weavewing Dev"],
  ["preview", VARIANT_IDENTIFIERS.preview, "Weavewing Preview"],
  ["production", VARIANT_IDENTIFIERS.production, "Weavewing"],
])("uses Weavewing identifiers for APP_VARIANT=%j", async (value, identifier, name) => {
  const config = await loadConfig(value, DISTRIBUTION_SETTINGS);
  expect(config.name).toBe(name);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.ios?.appleTeamId).toBe(DISTRIBUTION_SETTINGS.T3CODE_APPLE_TEAM_ID);
  expect(config.owner).toBe(DISTRIBUTION_SETTINGS.T3CODE_EXPO_OWNER);
  expect(config.extra?.eas?.projectId).toBe(DISTRIBUTION_SETTINGS.T3CODE_EXPO_PROJECT_ID);
  expect(config.updates).toEqual({ enabled: false });
  const withUpdates = await loadConfig(value, {
    ...DISTRIBUTION_SETTINGS,
    T3CODE_MOBILE_UPDATES_ENABLED: "1",
  });
  expect(withUpdates.updates).toMatchObject({
    enabled: true,
    url: `https://u.expo.dev/${DISTRIBUTION_SETTINGS.T3CODE_EXPO_PROJECT_ID}`,
  });
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${identifier}`,
  ]);
});

it.each(Object.values(MOBILE_APP_VARIANTS))(
  "derives the Xcode project name prebuild gives $name",
  ({ name }) => {
    expect(mobileIosProjectName(name)).toBe(IOSConfig.XcodeUtils.sanitizedName(name));
  },
);

// Runs the checks prebuild applies before it generates the platform's native project.
async function prebuild(config: ExportedConfig, platform: ModPlatform) {
  const mod = config.mods?.[platform]?.dangerous;
  if (!mod) throw new Error(`No ${platform} prebuild check is registered.`);
  return mod({
    ...config,
    modRawConfig: config,
    modResults: undefined,
    modRequest: {
      projectRoot: import.meta.dirname,
      platformProjectRoot: import.meta.dirname,
      modName: "dangerous",
      platform,
      introspect: false,
      nextMod: (value) => value,
    },
  });
}

it.each(["preview", "production"])(
  "names the missing Expo settings when APP_VARIANT=%s loads",
  async (variant) => {
    await expect(
      loadConfig(variant, { T3CODE_EXPO_OWNER: DISTRIBUTION_SETTINGS.T3CODE_EXPO_OWNER }),
    ).rejects.toThrow(
      `APP_VARIANT=${variant} needs T3CODE_EXPO_PROJECT_ID. Set them in the repository-root .env.local or as EAS environment variables`,
    );
  },
);

it.each(["preview", "production"])(
  "requires the Apple team only to prebuild iOS for APP_VARIANT=%s",
  async (variant) => {
    const { T3CODE_APPLE_TEAM_ID: _, ...expoSettings } = DISTRIBUTION_SETTINGS;
    const config = await loadConfig(variant, expoSettings);
    await expect(prebuild(config, "android")).resolves.toBeDefined();
    await expect(prebuild(config, "ios")).rejects.toThrow(
      `APP_VARIANT=${variant} needs T3CODE_APPLE_TEAM_ID.`,
    );
  },
);

it("loads the production identity with no variant named but refuses to prebuild it", async () => {
  const config = await loadConfig(undefined);
  expect(config.ios?.bundleIdentifier).toBe(VARIANT_IDENTIFIERS.production);
  expect(config.updates).toEqual({ enabled: false });
  await expect(prebuild(config, "ios")).rejects.toThrow(
    "APP_VARIANT=production (the default) needs T3CODE_APPLE_TEAM_ID, T3CODE_EXPO_OWNER, T3CODE_EXPO_PROJECT_ID.",
  );
  await expect(prebuild(config, "android")).rejects.toThrow(
    "APP_VARIANT=production (the default) needs T3CODE_EXPO_OWNER, T3CODE_EXPO_PROJECT_ID.",
  );
});

it("builds development without account settings, with updates off", async () => {
  const config = await loadConfig("development");
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(config.updates).toEqual({ enabled: false });
  await expect(prebuild(config, "ios")).resolves.toBeDefined();
  await expect(prebuild(config, "android")).resolves.toBeDefined();
});

it("builds a Personal Team iOS release without account settings, but not Android", async () => {
  const config = await loadConfig("production", {
    T3CODE_IOS_PERSONAL_TEAM: "1",
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.weavewing",
  });
  expect(config.ios?.bundleIdentifier).toBe("com.example.weavewing");
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    "$(AppIdentifierPrefix)com.example.weavewing",
  ]);
  expect(config.updates).toEqual({ enabled: false });
  await expect(prebuild(config, "ios")).resolves.toBeDefined();
  await expect(prebuild(config, "android")).rejects.toThrow(
    "APP_VARIANT=production needs T3CODE_EXPO_OWNER, T3CODE_EXPO_PROJECT_ID.",
  );
});

it("omits associated domains and Sign in with Apple without Clerk or a hosted app", async () => {
  const config = await loadConfig("production", DISTRIBUTION_SETTINGS);
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toBeUndefined();
  expect(clerkPluginOptions(config)).toMatchObject({ appleSignIn: false });
  expect(config.extra?.hostedApp).toEqual({ url: null });
});

it("entitles the configured Clerk and hosted app hosts", async () => {
  const config = await loadConfig("production", {
    ...DISTRIBUTION_SETTINGS,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: CLERK_PUBLISHABLE_KEY,
    T3CODE_HOSTED_APP_URL: "https://app.example.com",
  });
  expect(config.ios?.associatedDomains).toEqual([
    "applinks:clerk.example.com",
    "webcredentials:clerk.example.com",
    "applinks:app.example.com",
  ]);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host: "app.example.com", pathPrefix: "/threads/" },
  ]);
  expect(clerkPluginOptions(config)).toMatchObject({ appleSignIn: true });
  expect(config.extra?.hostedApp).toEqual({ url: "https://app.example.com" });
});

it.each([
  ["production", DISTRIBUTION_SETTINGS],
  ["preview", DISTRIBUTION_SETTINGS],
  [
    "production",
    {
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.weavewing",
      T3CODE_RELAY_URL: "https://relay.example.com",
    },
  ],
])("requests no push entitlement for APP_VARIANT=%s with %o", async (variant, env) => {
  const { entitlements, infoPlist } = await introspectIos(await loadConfig(variant, env));
  expect(entitlements).not.toHaveProperty("aps-environment");
  expect(infoPlist?.ExpoWidgets_EnablePushNotifications).not.toBe(true);
});

it("requests push for the widgets and the app when a relay is configured", async () => {
  const { entitlements, infoPlist } = await introspectIos(
    await loadConfig("production", {
      ...DISTRIBUTION_SETTINGS,
      T3CODE_RELAY_URL: "https://relay.example.com",
    }),
  );
  expect(entitlements).toHaveProperty("aps-environment");
  expect(infoPlist?.ExpoWidgets_EnablePushNotifications).toBe(true);
});

it.each(["app.example.com", "http://app.example.com"])(
  "rejects the hosted app URL %s",
  async (value) => {
    await expect(loadConfig("development", { T3CODE_HOSTED_APP_URL: value })).rejects.toThrow(
      "T3CODE_HOSTED_APP_URL must be an https URL",
    );
  },
);

it.each(["development", "preview", "production"])(
  "carries no upstream account or host for APP_VARIANT=%s",
  async (variant) => {
    const config = await loadConfig(variant, DISTRIBUTION_SETTINGS);
    expect(JSON.stringify(config)).not.toMatch(/t3tools|t3\.codes|pingdotgg|ARK85ZXQ4Z|T3 Code/);
  },
);

it("lists only Weavewing app identifiers in the hosted app's .well-known files", () => {
  const identifiers = Object.values(VARIANT_IDENTIFIERS);
  const appIds: readonly string[] = appleAppSiteAssociation.applinks.details.flatMap(
    (detail) => detail.appIDs,
  );
  for (const appId of appIds) {
    expect(identifiers).toContain(appId.replace(/^[A-Z0-9]{10}\./, ""));
  }
  const packages: readonly string[] = (
    assetLinks as ReadonlyArray<{ target: { package_name: string } }>
  ).map((link) => link.target.package_name);
  for (const packageName of packages) {
    expect(identifiers).toContain(packageName);
  }
});
