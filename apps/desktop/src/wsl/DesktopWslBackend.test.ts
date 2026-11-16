import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as NetService from "@t3tools/shared/Net";

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslBackend from "./DesktopWslBackend.ts";

function makeStubInstance(input: {
  readonly id: DesktopBackendPool.BackendInstanceId;
  readonly label: string;
  readonly snapshot: DesktopBackendSnapshot;
  readonly start?: Effect.Effect<void>;
}): DesktopBackendPool.DesktopBackendInstance {
  return {
    id: input.id,
    label: Effect.succeed(input.label),
    start: input.start ?? Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(input.snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

const idleSnapshot: DesktopBackendSnapshot = {
  desiredRunning: false,
  ready: false,
  activePid: Option.none(),
  restartAttempt: 5,
  restartScheduled: false,
};

const primarySnapshot: DesktopBackendSnapshot = {
  desiredRunning: true,
  ready: true,
  activePid: Option.some(123),
  restartAttempt: 0,
  restartScheduled: false,
};

const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerBackendConfiguration = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.die("unexpected currentBootstrapToken"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const layerNet = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
} satisfies NetService.NetService["Service"]);

describe("DesktopWslBackend", () => {
  it.effect("ignores stale Windows bind reservations on a free mirrored port", () =>
    Effect.gen(function* () {
      assert.equal(yield* DesktopWslBackend.scanForWslPort(3774, "mirrored"), 3774);
    }).pipe(
      Effect.provideService(NetService.NetService, {
        canListenOnHost: () => Effect.die("Windows retains closed mirrored listeners"),
        isPortAvailableOnLoopback: () => Effect.succeed(false),
        hasListenerOnHost: () => Effect.succeed(false),
        reserveLoopbackPort: () => Effect.succeed(41773),
        findAvailablePort: (preferred) => Effect.succeed(preferred),
      }),
    ),
  );

  it.effect("falls back to the NAT scan when the mirrored preferred port has a listener", () =>
    Effect.gen(function* () {
      let checks = 0;
      const pending = yield* DesktopWslBackend.scanForWslPort(3774, "mirrored").pipe(
        Effect.provideService(NetService.NetService, {
          canListenOnHost: (port) =>
            Effect.sync(() => {
              checks += 1;
              return port === 3776;
            }),
          hasListenerOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(41773),
          findAvailablePort: (port) => Effect.succeed(port),
        }),
        Effect.forkChild,
      );
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Fiber.join(pending), 3776);
      assert.equal(checks, 122);
    }),
  );

  it.effect("waits for the preferred port so peer links keep a stable URL across restarts", () => {
    let preferredChecks = 0;
    const layerBusyPreferred = Layer.succeed(NetService.NetService, {
      canListenOnHost: (port) => Effect.sync(() => (port === 3774 ? ++preferredChecks > 40 : true)),
      isPortAvailableOnLoopback: () => Effect.succeed(true),
      hasListenerOnHost: () => Effect.succeed(false),
      reserveLoopbackPort: () => Effect.succeed(41773),
      findAvailablePort: (preferred) => Effect.succeed(preferred),
    } satisfies NetService.NetService["Service"]);
    return Effect.gen(function* () {
      const fiber = yield* DesktopWslBackend.scanForWslPort(3774).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Fiber.join(fiber), 3774);
    }).pipe(Effect.provide(layerBusyPreferred));
  });

  it.effect("clears the stored preflight error when a registered WSL backend becomes ready", () => {
    let registeredSpec: DesktopBackendPool.BackendInstanceSpec | undefined;
    let registeredWsl: DesktopBackendPool.DesktopBackendInstance | undefined;
    let startCount = 0;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: (id) =>
        Effect.succeed(
          id === DesktopBackendPool.PRIMARY_INSTANCE_ID
            ? Option.some(primary)
            : Option.none<DesktopBackendPool.DesktopBackendInstance>(),
        ),
      list: Effect.sync(() => (registeredWsl === undefined ? [primary] : [primary, registeredWsl])),
      primary: Effect.succeed(primary),
      register: (spec) =>
        Effect.sync(() => {
          registeredSpec = spec;
          registeredWsl = makeStubInstance({
            id: spec.id,
            label: "WSL",
            snapshot: idleSnapshot,
            start: Effect.sync(() => {
              startCount += 1;
            }),
          });
          return registeredWsl;
        }),
      unregister: () =>
        Effect.sync(() => {
          registeredWsl = undefined;
        }),
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;
      const spec = registeredSpec;
      assert.isDefined(spec);
      if (spec === undefined) {
        throw new Error("Expected WSL backend registration");
      }
      const recordFailure = spec.onPreflightFailed;
      const recordOwnershipFailure = spec.onStateDirOwned;
      const clearFailure = spec.onReady;
      assert.isDefined(recordFailure);
      assert.isDefined(recordOwnershipFailure);
      assert.isDefined(clearFailure);
      if (
        recordFailure === undefined ||
        recordOwnershipFailure === undefined ||
        clearFailure === undefined
      ) {
        throw new Error("Expected WSL backend callbacks");
      }

      assert.isFalse(yield* recordFailure({ reason: "Node.js not found", fatal: true }));
      assert.deepEqual(yield* backend.lastPreflightError, Option.some("Node.js not found"));

      yield* recordOwnershipFailure();
      const refusal = yield* backend.lastPreflightError;
      assert.include(Option.getOrThrow(refusal), "Another T3 Code server");
      yield* backend.reconcile;
      assert.equal(startCount, 1);
      assert.deepEqual(yield* backend.lastPreflightError, refusal);

      yield* clearFailure(new URL("http://127.0.0.1:41773"), 123);
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
      yield* recordOwnershipFailure();
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* settings.setWslDistro("Debian");
      yield* backend.reconcile;
      assert.equal(startCount, 2);
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
      const nextSpec = registeredSpec;
      if (nextSpec?.onStateDirOwned === undefined) throw new Error("Expected ownership callback");
      yield* nextSpec.onStateDirOwned();
      yield* settings.setWslBackendEnabled(false);
      yield* backend.reconcile;
      yield* settings.setWslBackendEnabled(true);
      yield* backend.reconcile;
      assert.equal(startCount, 3);
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provideMerge(layerPool),
          Layer.provideMerge(layerBackendConfiguration),
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(layerNet),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
        ),
      ),
    );
  });
});
