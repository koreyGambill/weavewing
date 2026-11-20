// @effect-diagnostics-next-line nodeBuiltinImport:off -- independent HMAC oracle for signed pushes
import * as NodeCrypto from "node:crypto";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import {
  EnvironmentId,
  StatusSourceList,
  type StatusPayload,
  type StatusSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Probe from "./StatusSourceProbe.ts";
import * as Notifications from "../notifications/NotificationService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as StatusSources from "./StatusSources.ts";

const payload = (state: StatusPayload["state"]): StatusPayload => ({
  source: "Fixture",
  state,
  summary: `Fixture ${state}`,
  items: [],
});

const encodeList = Schema.encodeEffect(StatusSourceList);

const setup = Effect.gen(function* () {
  const calls =
    yield* Queue.unbounded<Parameters<Probe.StatusSourceProbe["Service"]["check"]>[0]>();
  const results = yield* Queue.unbounded<StatusPayload>();
  const probe = Layer.succeed(
    Probe.StatusSourceProbe,
    Probe.StatusSourceProbe.of({
      check: (input) => Queue.offer(calls, input).pipe(Effect.andThen(Queue.take(results))),
      favicon: () => Effect.undefined,
    }),
  );
  const context = yield* Layer.build(
    StatusSources.layer.pipe(Layer.provide(probe), Layer.provide(Notifications.layer)),
  );
  const service = Context.get(context, StatusSources.StatusSources);
  const updates = yield* Queue.unbounded<ReadonlyArray<StatusSource>>();
  yield* Stream.runForEach(service.subscribe(), (value) => Queue.offer(updates, value)).pipe(
    Effect.forkScoped,
  );
  yield* Queue.take(updates);
  return { service, calls, results, updates };
});

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "status-sources-" })),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer, Sqlite.layerMemory),
  ),
);

it.effect(
  "keeps credentials out of config and subscriptions, retains them on edit, and removes config",
  () =>
    Effect.gen(function* () {
      const { service, calls } = yield* setup;
      const source = yield* service.upsert({
        name: "Health",
        kind: "http-health",
        icon: "globe",
        target: "https://user:password@example.com/private-token/health?token=secret",
        headers: { Authorization: "Bearer hidden" },
      });
      expect(source.config.target).toBe("https://example.com/");
      expect((yield* Queue.take(calls)).target).toBe(
        "https://user:password@example.com/private-token/health?token=secret",
      );
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const persisted = yield* fs.readFileString(`${config.stateDir}/status-sources.json`);
      expect(persisted).not.toMatch(/password|secret|hidden|private-token/);
      expect(JSON.stringify(yield* service.list())).not.toMatch(
        /password|secret|hidden|private-token/,
      );
      yield* service.upsert({
        id: source.config.id,
        name: "Renamed",
        kind: "http-health",
        icon: "globe",
      });
      expect((yield* service.list())[0]?.config.hasCredentials).toBe(true);
      expect((yield* Queue.take(calls)).target).toBe(
        "https://user:password@example.com/private-token/health?token=secret",
      );
      yield* service.remove({ id: source.config.id });
      expect(yield* service.list()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "emits changes once, preserves the last transition, and snoozes without hiding current state",
  () =>
    Effect.gen(function* () {
      const { service, results, updates, calls } = yield* setup;
      const transitions = yield* Queue.unbounded<StatusSources.StatusSourceTransition>();
      yield* Stream.runForEach(service.transitions, (value) =>
        Queue.offer(transitions, value),
      ).pipe(Effect.forkScoped);
      const source = yield* service.upsert({
        name: "Fixture",
        kind: "wing-status",
        icon: "activity",
        target: "http://127.0.0.1/status",
        intervalSeconds: 30,
      });
      yield* Queue.take(updates);
      yield* Queue.take(calls);
      yield* Queue.offer(results, payload("ok"));
      expect((yield* Queue.take(updates))[0]?.lastTransition).toBeNull();
      yield* TestClock.adjust("34 seconds");
      yield* Queue.take(calls);
      yield* Queue.offer(results, payload("fail"));
      const failed = (yield* Queue.take(updates))[0]!;
      expect(failed.lastTransition).toMatchObject({ from: "ok", to: "fail" });
      const transition = failed.lastTransition;
      // The first observation is not a transition; ok -> fail publishes exactly one.
      expect(yield* Queue.take(transitions)).toEqual({
        sourceId: source.config.id,
        name: "Fixture",
        ...transition,
      });
      yield* TestClock.adjust("70 seconds");
      yield* Queue.take(calls);
      yield* Queue.offer(results, { ...payload("fail"), updatedAt: "2026-01-01T00:00:00Z" });
      yield* service.snooze({ id: source.config.id, until: "2099-01-01T00:00:00Z" });
      const snoozed = (yield* Queue.take(updates))[0]!;
      expect(snoozed.latest.state).toBe("fail");
      expect(snoozed.lastTransition).toEqual(transition);
      expect(yield* Queue.size(updates)).toBe(0);
      expect(yield* Queue.size(transitions)).toBe(0);
      yield* TestClock.adjust("140 seconds");
      yield* Queue.take(calls);
      yield* Queue.offer(results, payload("ok"));
      const recovered = (yield* Queue.take(updates))[0]!;
      expect(recovered.latest.state).toBe("ok");
      expect(recovered.lastTransition).toMatchObject({ from: "fail", to: "ok" });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("enforces the minimum interval and backs off failed polls with TestClock", () =>
  Effect.gen(function* () {
    const { service, results, updates, calls } = yield* setup;
    yield* service.upsert({
      name: "Health",
      kind: "http-health",
      icon: "globe",
      target: "http://localhost/health",
      intervalSeconds: 1,
    });
    expect((yield* Queue.take(updates))[0]?.config.intervalSeconds).toBe(30);
    yield* Queue.take(calls);
    yield* Queue.offer(results, payload("unknown"));
    yield* Queue.take(updates);
    yield* TestClock.adjust("59 seconds");
    expect(yield* Queue.size(calls)).toBe(0);
    yield* TestClock.adjust("8 seconds");
    yield* Queue.take(calls);
    yield* Queue.offer(results, payload("ok"));
    yield* Queue.take(updates);
    yield* TestClock.adjust("29 seconds");
    expect(yield* Queue.size(calls)).toBe(0);
    yield* TestClock.adjust("5 seconds");
    yield* Queue.take(calls);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "verifies signed pushes, rejects stale or replayed updates, and preserves only the newest state",
  () =>
    Effect.gen(function* () {
      const { service } = yield* setup;
      const source = yield* service.upsert({ name: "Push", kind: "webhook", icon: "activity" });
      const { secret } = yield* service.rotateWebhookSecret({ id: source.config.id });
      const push = (state: StatusPayload["state"], updatedAt: string, key = secret) => {
        const body = new TextEncoder().encode(JSON.stringify({ ...payload(state), updatedAt }));
        return service.webhook({
          id: source.config.id,
          body,
          headers: {
            "x-t3-signature": `sha256=${NodeCrypto.createHmac("sha256", key).update(body).digest("hex")}`,
          },
        });
      };
      expect(yield* push("ok", "1970-01-01T00:00:00.000Z", "wrong")).toBe(false);
      expect(yield* push("ok", "1970-01-01T00:00:00.000Z")).toBe(true);
      yield* TestClock.adjust("1 second");
      expect(yield* push("fail", "1970-01-01T00:00:01.000Z")).toBe(true);
      expect(yield* push("ok", "1970-01-01T00:00:00.500Z")).toBe(false);
      expect(yield* push("ok", "1970-01-01T00:00:01.000Z")).toBe(false);
      expect((yield* service.list())[0]?.latest.state).toBe("fail");
      yield* TestClock.adjust("1 second");
      expect(yield* push("ok", "1970-01-01T00:00:02.000Z")).toBe(true);
      expect((yield* service.list())[0]?.lastTransition).toMatchObject({ from: "fail", to: "ok" });
      yield* TestClock.adjust("6 minutes");
      expect(yield* push("fail", "1970-01-01T00:00:03.000Z")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "rolls back credentials when a secret write reports failure after changing the file",
  () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const { service } = yield* setup.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, {
          ...secrets,
          set: (name, bytes) =>
            secrets.set(name, bytes).pipe(
              Effect.andThen(() =>
                new TextDecoder().decode(bytes).includes("new.test")
                  ? Effect.fail(
                      new ServerSecretStore.SecretStorePersistError({
                        resource: "fixture",
                        cause: new Error("write failed"),
                      }),
                    )
                  : Effect.void,
              ),
            ),
        }),
      );
      const source = yield* service.upsert({
        name: "Original",
        kind: "http-health",
        icon: "activity",
        target: "https://old.test/health",
      });
      yield* service
        .upsert({
          id: source.config.id,
          name: "Changed",
          kind: "http-health",
          icon: "activity",
          target: "https://new.test/health",
        })
        .pipe(Effect.flip);
      const stored = yield* secrets.get(`status-source-${source.config.id}`);
      expect(new TextDecoder().decode(Option.getOrThrow(stored))).toContain("old.test");
      expect((yield* service.list())[0]?.config.name).toBe("Original");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "shares new sources by default, keeps the choice on edit, and reads old configs as shared",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        `${config.stateDir}/status-sources.json`,
        JSON.stringify([
          {
            id: "legacy",
            name: "Legacy",
            kind: "webhook",
            icon: "activity",
            intervalSeconds: 60,
            timeoutSeconds: 10,
            snoozedUntil: null,
            target: "",
            hasCredentials: false,
          },
        ]),
      );
      const { service } = yield* setup;
      expect((yield* service.list())[0]?.config.shared).toBe(true);
      const created = yield* service.upsert({ name: "Hook", kind: "webhook", icon: "activity" });
      expect(created.config.shared).toBe(true);
      const unshared = yield* service.upsert({
        id: created.config.id,
        name: "Hook",
        kind: "webhook",
        icon: "activity",
        shared: false,
      });
      expect(unshared.config.shared).toBe(false);
      const renamed = yield* service.upsert({
        id: created.config.id,
        name: "Renamed",
        kind: "webhook",
        icon: "activity",
      });
      expect(renamed.config.shared).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("mirrors a linked environment's sources read-only, without inbox alerts here", () =>
  Effect.gen(function* () {
    const { service, updates } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const environmentId = EnvironmentId.make("environment:peer");
    const label = "L".repeat(250);
    const shared: StatusSource = {
      config: {
        id: "disk",
        name: "Disk",
        kind: "command",
        icon: "terminal",
        intervalSeconds: 60,
        timeoutSeconds: 10,
        snoozedUntil: null,
        target: "",
        hasCredentials: true,
        shared: true,
      },
      latest: payload("fail"),
      lastTransition: { from: "ok", to: "fail", at: "2026-01-01T00:00:00.000Z" },
    };
    yield* service.mirror({ environmentId, label, sources: [shared] });
    const [mirrored] = yield* Queue.take(updates);
    expect(mirrored).toMatchObject({
      config: { id: "environment:peer:disk" },
      lastTransition: shared.lastTransition,
      origin: { environmentId, label: label.slice(0, 200) },
    });
    // A long peer label still encodes for subscribers.
    yield* encodeList(yield* service.list());
    expect(yield* sql`SELECT id FROM notifications`).toEqual([]);
    const refused = yield* service
      .snooze({ id: mirrored!.config.id, until: null })
      .pipe(Effect.flip);
    expect(refused.operation).toBe("source-not-found");
    yield* service.mirror({ environmentId, label, sources: [] });
    expect(yield* Queue.take(updates)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps a running check's state when only sharing changes", () =>
  Effect.gen(function* () {
    const { service, calls, results, updates } = yield* setup;
    const input = {
      name: "Fixture",
      kind: "wing-status" as const,
      icon: "activity",
      target: "http://127.0.0.1/status",
    };
    const source = yield* service.upsert(input);
    yield* Queue.take(updates);
    yield* Queue.take(calls);
    yield* Queue.offer(results, payload("fail"));
    yield* Queue.take(updates);
    yield* service.upsert({ ...input, id: source.config.id, shared: false });
    const [unshared] = yield* Queue.take(updates);
    expect(unshared).toMatchObject({ config: { shared: false }, latest: { state: "fail" } });
    expect(yield* Queue.size(calls)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps the chosen source order through edits, restarts, and mirrors", () =>
  Effect.gen(function* () {
    const { service, updates } = yield* setup;
    const names = (sources: ReadonlyArray<StatusSource>) =>
      sources.map((source) => source.config.name);
    const add = (name: string) => service.upsert({ name, kind: "webhook", icon: "activity" });
    const a = yield* add("A");
    yield* add("B");
    const c = yield* add("C");
    yield* service.reorder({ ids: [c.config.id, a.config.id, "missing"] });
    expect(names(yield* service.list())).toEqual(["C", "A", "B"]);
    yield* service.upsert({ id: a.config.id, name: "A2", kind: "webhook", icon: "activity" });
    const restarted = yield* setup;
    expect(names(yield* restarted.service.list())).toEqual(["C", "A2", "B"]);

    const environmentId = EnvironmentId.make("environment:peer");
    const peer = [c, a].map((source) => ({ ...source, config: { ...source.config } }));
    const mirrorNames = Queue.take(updates).pipe(
      Effect.map((sources) => names(sources.filter((source) => source.origin)).join()),
    );
    yield* service.mirror({ environmentId, label: "Peer", sources: peer });
    while ((yield* mirrorNames) !== "Peer · C,Peer · A");
    // A reorder alone still reaches subscribers.
    yield* service.mirror({ environmentId, label: "Peer", sources: peer.toReversed() });
    while ((yield* mirrorNames) !== "Peer · A,Peer · C");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
