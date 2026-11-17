import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appUserModelId, "dev.weavewing.desktop");
      assert.equal(environment.baseDir, "/Users/alice/.t3");
      assert.equal(environment.stateDir, "/Users/alice/.t3/userdata");
      assert.equal(environment.appDataDirectory, "/Users/alice/AppData/Roaming");
      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("serves the local updater client only while its marker matches the shell", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesPath = yield* fs.makeTempDirectoryScoped();
      const client = path.join(resourcesPath, "client");
      yield* fs.makeDirectory(client);
      yield* fs.writeFileString(path.join(client, "index.html"), "new client");
      const input = { platform: "win32", isPackaged: true, resourcesPath } as const;
      const sidecar = path.join(resourcesPath, "server.asar/apps/server/dist/client");

      yield* fs.writeFileString(path.join(client, ".shell-version"), "0.0.22\n");
      // Construction runs before Electron is ready; yielding lets Clerk's scheme registration fail.
      const construction = yield* makeEnvironment(input).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const constructed = construction.pollUnsafe();
      assert.ok(constructed && Exit.isSuccess(constructed), "construction yielded");
      const matching = constructed.value;
      assert.equal(matching.clientAssetsDir, client);
      assert.equal(
        matching.backendEntryPath,
        path.join(resourcesPath, "server.asar/apps/server/dist/bin.mjs"),
      );

      yield* fs.writeFileString(path.join(client, ".shell-version"), "0.0.21");
      assert.equal((yield* makeEnvironment(input)).clientAssetsDir, sidecar);

      yield* fs.remove(path.join(client, ".shell-version"));
      assert.equal((yield* makeEnvironment(input)).clientAssetsDir, sidecar);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );
});
