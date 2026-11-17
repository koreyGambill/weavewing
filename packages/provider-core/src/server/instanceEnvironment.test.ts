import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";
import { spawnAndCollect } from "./snapshotProbe.ts";

const decodeEnvironment = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const quietDrivers = [
  { driver: "claudeAgent", defaults: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
  {
    driver: "grok",
    defaults: {
      GROK_DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    },
  },
  { driver: "opencode", defaults: { OPENCODE_DISABLE_AUTOUPDATE: "1" } },
  { driver: "pi", defaults: { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } },
  { driver: "muse", defaults: { MUSE_NO_AUTO_UPDATE: "1" } },
];

describe("mergeProviderInstanceEnvironment", () => {
  it.live.each(quietDrivers)(
    "disables $driver nonessential traffic below explicit values",
    ({ driver, defaults }) =>
      Effect.gen(function* () {
        const launch = (environment: NodeJS.ProcessEnv) =>
          spawnAndCollect(
            process.execPath,
            ChildProcess.make(
              process.execPath,
              ["-e", "process.stdout.write(JSON.stringify(process.env))"],
              { env: environment, extendEnv: false },
            ),
          ).pipe(Effect.map((result) => decodeEnvironment(result.stdout)));
        const defaultEnvironment = yield* mergeProviderInstanceEnvironment(
          undefined,
          { PATH: "/bin" },
          driver,
        );
        expect(yield* launch(defaultEnvironment)).toMatchObject(defaults);
        for (const name of Object.keys(defaults)) {
          const inherited = { [name]: "", KEEP: "yes" };
          const configured = [{ name, value: "explicit", sensitive: false }];
          expect(
            (yield* mergeProviderInstanceEnvironment(undefined, inherited, driver))[name],
          ).toBe("");
          expect(
            (yield* mergeProviderInstanceEnvironment(configured, inherited, driver))[name],
          ).toBe("explicit");
          const overridden = yield* mergeProviderInstanceEnvironment(configured, {}, driver);
          expect((yield* launch(overridden))[name]).toBe("explicit");
          expect(inherited).toEqual({ [name]: "", KEEP: "yes" });
          const lower = name.toLowerCase();
          const windows = yield* mergeProviderInstanceEnvironment(
            undefined,
            { [lower]: "" },
            driver,
          ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
          expect(windows[name]).toBeUndefined();
          expect(windows[lower]).toBe("");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("strips the launching agent identity for every provider", () =>
    Effect.gen(function* () {
      const inherited = {
        CLAUDE_CODE_SESSION_ID: "parent",
        CODEX_THREAD_ID: "parent",
        CODEX_SESSION_ID: "parent",
        AI_AGENT: "claude",
        CLAUDECODE: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: "/parent/socket",
        PATH: "/bin",
      };
      const result = yield* mergeProviderInstanceEnvironment(undefined, inherited);
      expect(result.PATH).toBe("/bin");
      for (const name of Object.keys(inherited).filter((name) => name !== "PATH"))
        expect(result[name]).toBe("");
      expect(inherited.CODEX_THREAD_ID).toBe("parent");
    }),
  );

  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        GROK_HOME: "~/.inherited-grok",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "GROK_HOME", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        GROK_HOME: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        GROK_HOME: "~/.inherited-grok",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // A home variable in another spelling is still expanded.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "Codex_Home", value: "~/corp", sensitive: false }],
          {},
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
        ),
      ).toEqual({ CODEX_HOME: "/home/ada/corp" });
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );
});
