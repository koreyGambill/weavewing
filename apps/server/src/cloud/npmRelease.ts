import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import {
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  npmReleaseDatabaseMigration,
} from "@t3tools/shared/cliRelease";
import { RELEASE_REPOSITORY, releaseTag } from "@t3tools/shared/releaseIdentity";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optionalKey(Schema.Boolean),
  }),
);
const Manifest = Schema.Struct({ version: Schema.String, t3code: Schema.Unknown });
const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(
      function* (spec: string) {
        let version: string | undefined;
        for (let page = 1; page <= 5; page++) {
          const response = yield* http.get(cliReleaseIndexPageUrl(page));
          if (response.status !== 200)
            return yield* new ServerNpmReleaseError({
              reason: "Could not read Weavewing releases from GitHub.",
            });
          const releases = yield* decodeIndex(yield* response.text);
          version =
            spec === "latest" || spec === "nightly"
              ? newestCliReleaseVersion(releases, spec === "latest" ? "stable" : "nightly")
              : releases.some((release) => !release.draft && release.tag_name === releaseTag(spec))
                ? spec
                : undefined;
          if (version !== undefined || releases.length < 100) break;
        }
        if (version === undefined) return null;
        const response = yield* http.get(
          `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseTag(version)}/release-metadata.json`,
        );
        if (response.status !== 200)
          return yield* new ServerNpmReleaseError({
            reason: "This Weavewing release has no database compatibility metadata.",
          });
        const manifest = yield* decodeManifest(yield* response.text).pipe(
          Effect.mapError(
            () =>
              new ServerNpmReleaseError({
                reason: "Invalid Weavewing database compatibility metadata.",
              }),
          ),
        );
        const databaseMigration = npmReleaseDatabaseMigration(manifest);
        if (manifest.version !== version || databaseMigration === undefined)
          return yield* new ServerNpmReleaseError({
            reason: "Invalid Weavewing database compatibility metadata.",
          });
        return { version, databaseMigration };
      },
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError((error) =>
        error instanceof ServerNpmReleaseError
          ? error
          : new ServerNpmReleaseError({ reason: "Could not check Weavewing release compatibility." }),
      ),
    ),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
