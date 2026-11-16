import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as WeavewingAnalytics from "./WeavewingAnalytics.ts";

const telemetryOn = {
  T3CODE_TELEMETRY_ENABLED: "true",
  T3CODE_POSTHOG_KEY: "phc_test_key",
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Weavewing analytics", (it) => {
  it.effect("the server's analytics layer sends nothing, even with telemetry forced on", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-weavewing-home-" });
      const requests: Array<string> = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
        );
      });
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-weavewing-analytics-",
      });

      const anonymousIdPath = yield* Effect.scoped(
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.record("server.boot.heartbeat", { threadCount: 1 });
          yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
          yield* analytics.recordOwners([{ source: "device", ownerId: "b".repeat(64) }], "client");
          yield* analytics.flush;
          yield* TestClock.adjust("1 minute");
          return (yield* ServerConfig.ServerConfig).anonymousIdPath;
        }).pipe(
          Effect.provide(
            WeavewingAnalytics.layer.pipe(
              Layer.provideMerge(serverConfigLayer),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(telemetryOn))),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpClient.HttpClient, client),
                  ManagedPolicy.layerTest(),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Effect.provideService(HostProcess.Environment, telemetryOn),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );

      assert.deepEqual(requests, []);
      assert.isFalse(yield* fileSystem.exists(anonymousIdPath));
    }),
  );

  it.effect("the server wires the no-op layer and nothing provides the live one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const srcDir = path.resolve(import.meta.dirname, "..");
      const serverSource = yield* fileSystem.readFileString(path.join(srcDir, "server.ts"));
      assert.include(serverSource, "Layer.provideMerge(WeavewingAnalytics.layer)");

      const liveLayerUse =
        /\bAnalyticsService\.(?:layer|make)\b|import\s*\{[^}]*\b(?:layer|make)\b[^}]*\}\s*from\s*"[^"]*AnalyticsService\.ts"/;
      const offenders: Array<string> = [];
      for (const file of yield* fileSystem.readDirectory(srcDir, { recursive: true })) {
        if (!file.endsWith(".ts") || /\.test\.ts$/.test(file)) continue;
        if (liveLayerUse.test(yield* fileSystem.readFileString(path.join(srcDir, file)))) {
          offenders.push(file);
        }
      }
      assert.deepEqual(offenders, []);
    }),
  );
});
