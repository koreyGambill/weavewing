import {
  type EnvironmentId,
  StatusPayload,
  StatusSourceConfig,
  StatusSourcesError,
  type StatusSource,
  type StatusSourceUpsertInput,
  type StatusSourceReorderInput,
  type StatusSourceSnoozeInput,
  type StatusState,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { verifyWebhookSignature } from "../scheduledTasks/webhookVerification.ts";
import * as NotificationService from "../notifications/NotificationService.ts";
import * as Probe from "./StatusSourceProbe.ts";

export interface StatusSourceTransition {
  readonly sourceId: string;
  readonly name: string;
  readonly from: StatusState;
  readonly to: StatusState;
  readonly at: string;
}

export class StatusSources extends Context.Service<
  StatusSources,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<StatusSource>, StatusSourcesError>;
    readonly subscribe: () => Stream.Stream<ReadonlyArray<StatusSource>, StatusSourcesError>;
    readonly upsert: (
      input: StatusSourceUpsertInput,
    ) => Effect.Effect<StatusSource, StatusSourcesError>;
    readonly remove: (input: { readonly id: string }) => Effect.Effect<void, StatusSourcesError>;
    /** Puts the listed sources first, in that order; unlisted ones keep their order after them. */
    readonly reorder: (input: StatusSourceReorderInput) => Effect.Effect<void, StatusSourcesError>;
    readonly snooze: (
      input: StatusSourceSnoozeInput,
    ) => Effect.Effect<StatusSource, StatusSourcesError>;
    readonly rotateWebhookSecret: (input: {
      readonly id: string;
    }) => Effect.Effect<{ readonly secret: string }, StatusSourcesError>;
    readonly webhook: (input: {
      readonly id: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }) => Effect.Effect<boolean, StatusSourcesError>;
    /**
     * Replaces the read-only copies of the sources `environmentId` shares. An
     * empty list forgets them. Inbox alerts stay with the environment that runs
     * the check, so a copy seen through several links raises one.
     */
    readonly mirror: (input: {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly sources: ReadonlyArray<StatusSource>;
    }) => Effect.Effect<void>;
    /** One item per state change after a source's first observation. */
    readonly transitions: Stream.Stream<StatusSourceTransition>;
  }
>()("t3/statusSources/StatusSources") {}

const Credentials = Schema.Struct({
  target: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
});
const persistedSchema = Schema.Array(StatusSourceConfig).check(Schema.isMaxLength(64));
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));
const decodeConfig = Schema.decodeUnknownEffect(StatusSourceConfig);
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(StatusPayload));
const encodeConfigs = Schema.encodeEffect(Schema.fromJsonString(persistedSchema));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Credentials));
const samePayload = Schema.toEquivalence(StatusPayload);
const sameConfig = Schema.toEquivalence(StatusSourceConfig);
const sameCredentials = Schema.toEquivalence(Credentials);
const secretName = (id: string) => `status-source-${id}`;
const signingName = (id: string) => `status-source-signing-${id}`;
const utf8 = new TextEncoder();
const text = new TextDecoder();
const unknown = (name: string): StatusPayload => ({
  source: name,
  state: "unknown",
  summary: "Waiting for status",
  items: [],
});

function withoutObservationTimes(payload: StatusPayload): StatusPayload {
  return {
    ...payload,
    updatedAt: undefined,
    items: payload.items.map((item) => ({ ...item, updatedAt: undefined })),
  };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const probe = yield* Probe.StatusSourceProbe;
  const notifications = yield* NotificationService.NotificationService;
  const random = yield* SecureRandom.SecureRandom;
  const mac = yield* Mac.Mac;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const mutations = yield* Semaphore.make(1);
  const pollPermits = yield* Semaphore.make(4);
  const changes = yield* PubSub.sliding<void>(1);
  const transitions = yield* PubSub.sliding<StatusSourceTransition>(64);
  const configPath = path.join(server.stateDir, "status-sources.json");
  const loaded = yield* fs.readFileString(configPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(persistedSchema))),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
    Effect.mapError((cause) => new StatusSourcesError({ operation: "load", cause })),
  );
  const entries = new Map<string, StatusSource>(
    loaded.map((config) => [
      config.id,
      { config, latest: unknown(config.name), lastTransition: null },
    ]),
  );
  const mirrored = new Map<EnvironmentId, ReadonlyArray<StatusSource>>();
  const workers = new Map<string, Fiber.Fiber<void>>();
  const pollConfigs = new Map<string, StatusSourceConfig>();
  const initialized = new Set<string>();
  const list = Effect.fn("StatusSources.list")(() =>
    Effect.sync(() => [...entries.values(), ...[...mirrored.values()].flat()]),
  );
  const emit = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const persist = Effect.fn("StatusSources.persist")(function* (
    configs: ReadonlyArray<StatusSourceConfig>,
  ) {
    yield* writeFileStringAtomically({
      filePath: configPath,
      contents: yield* encodeConfigs(configs).pipe(
        Effect.mapError((cause) => new StatusSourcesError({ operation: "encode-config", cause })),
      ),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new StatusSourcesError({ operation: "persist", cause })),
    );
  });
  const credentials = Effect.fn("StatusSources.credentials")(function* (id: string) {
    const bytes = yield* secrets
      .get(secretName(id))
      .pipe(
        Effect.mapError((cause) => new StatusSourcesError({ operation: "read-secret", cause })),
      );
    return Option.isSome(bytes)
      ? yield* decodeCredentials(text.decode(bytes.value)).pipe(
          Effect.mapError((cause) => new StatusSourcesError({ operation: "decode-secret", cause })),
        )
      : { target: "", headers: {} };
  });
  const requireSource = Effect.fn("StatusSources.requireSource")(function* (id: string) {
    const source = entries.get(id);
    if (!source) return yield* new StatusSourcesError({ operation: "source-not-found" });
    return source;
  });
  const accept = Effect.fn("StatusSources.accept")(function* (
    config: StatusSourceConfig,
    value: StatusPayload,
    isWebhook = false,
  ) {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const source = entries.get(config.id);
        if (!source || (source.config !== config && pollConfigs.get(config.id) !== config))
          return false;
        if (isWebhook) {
          const previous = Date.parse(source.latest.updatedAt ?? "");
          if (Number.isFinite(previous) && Date.parse(value.updatedAt ?? "") <= previous)
            return false;
        }
        const latest = Probe.normalizeStatusPayload(value);
        const stateChanged = source.latest.state !== latest.state;
        const at = DateTime.formatIso(yield* DateTime.now);
        const transition =
          initialized.has(config.id) && stateChanged
            ? { from: source.latest.state, to: latest.state, at }
            : source.lastTransition;
        initialized.add(config.id);
        const changed = !samePayload(
          withoutObservationTimes(source.latest),
          withoutObservationTimes(latest),
        );
        entries.set(config.id, { ...source, latest, lastTransition: transition });
        if (transition !== source.lastTransition && transition !== null) {
          yield* PubSub.publish(transitions, {
            sourceId: config.id,
            name: config.name,
            ...transition,
          });
        }
        yield* notifications.observeStatus({ ...source, latest, lastTransition: transition });
        if (changed) yield* emit;
        return true;
      }),
    );
  });
  const stop = Effect.fn("StatusSources.stop")(function* (id: string) {
    const worker = workers.get(id);
    workers.delete(id);
    pollConfigs.delete(id);
    if (worker) yield* Fiber.interrupt(worker);
  });
  const launch = Effect.fn("StatusSources.launch")(function* (config: StatusSourceConfig) {
    if (config.kind === "webhook") return;
    pollConfigs.set(config.id, config);
    const run = Effect.gen(function* () {
      const stored = yield* credentials(config.id);
      let failures = 0;
      const favicon =
        config.icon === "favicon"
          ? yield* probe.favicon(stored.target).pipe(pollPermits.withPermits(1))
          : undefined;
      if (favicon && entries.get(config.id)?.config === config) {
        entries.set(config.id, { ...entries.get(config.id)!, favicon });
        yield* emit;
      }
      return yield* Effect.gen(function* () {
        const latest = yield* probe
          .check({
            kind: config.kind,
            target: stored.target,
            headers: stored.headers,
            timeoutSeconds: config.timeoutSeconds,
            name: config.name,
          })
          .pipe(
            pollPermits.withPermits(1),
            Effect.orElseSucceed(() => ({
              source: config.name,
              state: "unknown" as const,
              summary: "Status check failed",
              items: [],
            })),
          );
        yield* accept(config, latest);
        failures =
          latest.state === "unknown" || latest.state === "fail" ? Math.min(failures + 1, 5) : 0;
        const delay = Math.min(
          config.intervalSeconds * 2 ** failures,
          Math.max(config.intervalSeconds, 900),
        );
        const jitter = yield* Random.nextBetween(1, 1.1);
        yield* Effect.sleep(`${Math.ceil(delay * jitter * 1000)} millis`);
      }).pipe(Effect.forever);
    }).pipe(Effect.ignore);
    workers.set(config.id, yield* run.pipe(Effect.interruptible, Effect.forkIn(scope)));
  });
  const upsert = Effect.fn("StatusSources.upsert")(
    function* (input: StatusSourceUpsertInput) {
      const result = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const old = input.id ? yield* requireSource(input.id) : undefined;
          if (!old && entries.size >= 64)
            return yield* new StatusSourcesError({ operation: "source-limit" });
          const id =
            old?.config.id ??
            (yield* random
              .uuidV4()
              .pipe(
                Effect.mapError(
                  (cause) => new StatusSourcesError({ operation: "generate-id", cause }),
                ),
              ));
          const previous = old ? yield* credentials(id) : { target: "", headers: {} };
          const target = input.target ?? previous.target;
          const headers = input.headers ?? previous.headers;
          if (
            input.kind !== "webhook" &&
            (!target.trim() || (input.kind !== "command" && !Probe.statusTargetOrigin(target)))
          )
            return yield* new StatusSourcesError({ operation: "invalid-target" });
          if (
            Object.keys(headers).length > 32 ||
            Object.entries(headers).some(
              ([key, value]) =>
                key.length > 200 || value.length > 8192 || /[\r\n]/.test(key + value),
            )
          )
            return yield* new StatusSourcesError({ operation: "invalid-headers" });
          const cleanTarget =
            input.kind === "command" || input.kind === "webhook"
              ? ""
              : Probe.statusTargetOrigin(target)!;
          const config = yield* decodeConfig({
            id,
            name: input.name,
            kind: input.kind,
            icon: input.icon,
            intervalSeconds: Math.min(
              86400,
              Math.max(30, input.intervalSeconds ?? old?.config.intervalSeconds ?? 60),
            ),
            timeoutSeconds: Math.min(
              60,
              Math.max(1, input.timeoutSeconds ?? old?.config.timeoutSeconds ?? 10),
            ),
            snoozedUntil: old?.config.snoozedUntil ?? null,
            target: cleanTarget,
            hasCredentials:
              input.kind === "command" || target !== cleanTarget || Object.keys(headers).length > 0,
            shared: input.shared ?? old?.config.shared ?? true,
          }).pipe(
            Effect.mapError(
              (cause) => new StatusSourcesError({ operation: "validate-config", cause }),
            ),
          );
          const sameCheck =
            old !== undefined &&
            sameCredentials(previous, { target, headers }) &&
            sameConfig({ ...old.config, shared: config.shared }, config);
          const source: StatusSource = sameCheck
            ? { ...old, config }
            : { config, latest: unknown(config.name), lastTransition: null };
          const oldSecret = yield* secrets
            .get(secretName(id))
            .pipe(
              Effect.mapError(
                (cause) => new StatusSourcesError({ operation: "read-secret", cause }),
              ),
            );
          yield* Effect.gen(function* () {
            yield* secrets
              .set(
                secretName(id),
                utf8.encode(
                  yield* encodeCredentials({ target, headers }).pipe(
                    Effect.mapError(
                      (cause) => new StatusSourcesError({ operation: "encode-secret", cause }),
                    ),
                  ),
                ),
              )
              .pipe(
                Effect.mapError(
                  (cause) => new StatusSourcesError({ operation: "write-secret", cause }),
                ),
              );
            yield* persist(
              old
                ? Array.from(entries.values()).map((entry) =>
                    entry.config.id === id ? config : entry.config,
                  )
                : [...Array.from(entries.values()).map((entry) => entry.config), config],
            );
          }).pipe(
            Effect.tapError(() =>
              (Option.isSome(oldSecret)
                ? secrets.set(secretName(id), oldSecret.value)
                : secrets.remove(secretName(id))
              ).pipe(Effect.ignore),
            ),
          );
          entries.set(id, source);
          if (!sameCheck) {
            pollConfigs.delete(id);
            initialized.delete(id);
          }
          yield* emit;
          return { source, sameCheck };
        }),
      );
      // Only sharing changed: the running check and its baseline stay as they are.
      if (!result.sameCheck) {
        yield* stop(result.source.config.id);
        yield* launch(result.source.config);
      }
      return result.source;
    },
    Effect.uninterruptible,
    mutations.withPermits(1),
  );
  const remove = Effect.fn("StatusSources.remove")(
    function* ({ id }: { readonly id: string }) {
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* requireSource(id);
          yield* persist(
            Array.from(entries.values())
              .filter((entry) => entry.config.id !== id)
              .map((entry) => entry.config),
          );
          entries.delete(id);
          initialized.delete(id);
          yield* emit;
        }),
      );
      yield* stop(id);
      yield* Effect.all([secrets.remove(secretName(id)), secrets.remove(signingName(id))]).pipe(
        Effect.mapError((cause) => new StatusSourcesError({ operation: "remove-secret", cause })),
      );
    },
    Effect.uninterruptible,
    mutations.withPermits(1),
  );
  const reorder = Effect.fn("StatusSources.reorder")(
    function* ({ ids }: StatusSourceReorderInput) {
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = [...entries.values()];
          const ordered = [...new Set([...ids.flatMap((id) => entries.get(id) ?? []), ...current])];
          if (ordered.every((source, index) => source === current[index])) return;
          yield* persist(ordered.map((source) => source.config));
          entries.clear();
          for (const source of ordered) entries.set(source.config.id, source);
          yield* emit;
        }),
      );
    },
    Effect.uninterruptible,
    mutations.withPermits(1),
  );
  const snooze = Effect.fn("StatusSources.snooze")(
    function* ({ id, until }: StatusSourceSnoozeInput) {
      if (until !== null && !Number.isFinite(Date.parse(until)))
        return yield* new StatusSourcesError({ operation: "invalid-snooze" });
      const source = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* requireSource(id);
          const next = { ...current, config: { ...current.config, snoozedUntil: until } };
          yield* persist(
            Array.from(entries.values()).map((entry) =>
              entry.config.id === id ? next.config : entry.config,
            ),
          );
          entries.set(id, next);
          yield* emit;
          return next;
        }),
      );
      return source;
    },
    Effect.uninterruptible,
    mutations.withPermits(1),
  );
  const rotateWebhookSecret = Effect.fn("StatusSources.rotateWebhookSecret")(
    function* ({ id }: { readonly id: string }) {
      const source = yield* requireSource(id);
      if (source.config.kind !== "webhook")
        return yield* new StatusSourcesError({ operation: "not-webhook" });
      const secret = yield* random
        .uuidV4()
        .pipe(
          Effect.mapError(
            (cause) => new StatusSourcesError({ operation: "generate-signing-secret", cause }),
          ),
        );
      yield* secrets
        .set(signingName(id), utf8.encode(secret))
        .pipe(
          Effect.mapError(
            (cause) => new StatusSourcesError({ operation: "write-signing-secret", cause }),
          ),
        );
      return { secret };
    },
    Effect.uninterruptible,
    mutations.withPermits(1),
  );
  const webhook = Effect.fn("StatusSources.webhook")(function* (input: {
    readonly id: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }) {
    const source = entries.get(input.id);
    if (!source || source.config.kind !== "webhook" || input.body.byteLength > 256 * 1024)
      return false;
    const secret = yield* secrets
      .get(signingName(input.id))
      .pipe(
        Effect.mapError(
          (cause) => new StatusSourcesError({ operation: "read-signing-secret", cause }),
        ),
      );
    if (Option.isNone(secret)) return false;
    const verified = yield* verifyWebhookSignature({
      signature: { header: "x-t3-signature", prefix: "sha256=", encoding: "hex" },
      secret: text.decode(secret.value),
      headers: input.headers,
      body: input.body,
    }).pipe(
      Effect.provideService(Mac.Mac, mac),
      Effect.orElseSucceed(() => false),
    );
    if (!verified) return false;
    const value = yield* decodePayload(text.decode(input.body)).pipe(Effect.option);
    if (Option.isNone(value)) return false;
    const timestamp = Date.parse(value.value.updatedAt ?? "");
    const now = yield* Clock.currentTimeMillis;
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300_000) return false;
    return yield* accept(source.config, value.value, true);
  });
  const mirror = Effect.fn("StatusSources.mirror")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly sources: ReadonlyArray<StatusSource>;
  }) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const prefix = `${input.environmentId}:`;
        const label = input.label.trim().slice(0, 200) || input.environmentId.slice(0, 200);
        const origin = { environmentId: input.environmentId, label };
        const before = mirrored.get(input.environmentId) ?? [];
        const copies = input.sources.map((source): StatusSource => ({
          config: {
            ...source.config,
            id: `${prefix}${source.config.id}`.slice(0, 200),
            name: `${label} · ${source.config.name}`.slice(0, 200),
          },
          latest: source.latest,
          lastTransition: source.lastTransition,
          origin,
        }));
        const changed =
          before.length !== copies.length ||
          copies.some((copy, index) => {
            const previous = before[index]!;
            return (
              previous.config.id !== copy.config.id ||
              previous.config.name !== copy.config.name ||
              previous.config.icon !== copy.config.icon ||
              previous.config.snoozedUntil !== copy.config.snoozedUntil ||
              previous.lastTransition?.at !== copy.lastTransition?.at ||
              !samePayload(
                withoutObservationTimes(previous.latest),
                withoutObservationTimes(copy.latest),
              )
            );
          });
        if (copies.length > 0) mirrored.set(input.environmentId, copies);
        else mirrored.delete(input.environmentId);
        if (changed) yield* emit;
      }),
    );
  });
  for (const source of entries.values()) yield* launch(source.config);
  return StatusSources.of({
    list,
    upsert,
    remove,
    reorder,
    snooze,
    rotateWebhookSecret,
    webhook,
    mirror,
    transitions: Stream.fromPubSub(transitions),
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.fromEffect(list()).pipe(
            Stream.concat(Stream.fromSubscription(subscription).pipe(Stream.mapEffect(list))),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(StatusSources, make);
