import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";

import * as NpmRelease from "./npmRelease.ts";

const nightly = "0.2.0-nightly.20261117.1";
const stable = "0.1.0";
const index = [
  { tag_name: "v9.0.0" },
  { tag_name: "weavewing-v0.3.0", draft: true },
  { tag_name: `weavewing-v${nightly}`, prerelease: true },
  { tag_name: `weavewing-v${stable}`, prerelease: false },
];

it.effect.each([
  { spec: "latest", version: stable },
  { spec: "nightly", version: nightly },
  { spec: nightly, version: nightly },
])("looks up fork $spec and caches its database compatibility metadata", ({ spec, version }) =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          urls.push(request.url);
          const body = request.url.includes("api.github.com")
            ? index
            : { version, t3code: { databaseMigration: 84 } };
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body))),
          );
        }),
      ),
    );
    expect(yield* service.get({ spec })).toEqual({ version, databaseMigration: 84 });
    expect(yield* service.get({ spec })).toEqual({ version, databaseMigration: 84 });
    expect(urls).toEqual([
      "https://api.github.com/repos/koreyGambill/weavewing/releases?per_page=100&page=1",
      `https://github.com/koreyGambill/weavewing/releases/download/weavewing-v${version}/release-metadata.json`,
    ]);
  }),
);

it.effect.each([
  { status: 404, body: {} },
  { status: 200, body: { version: "9.9.9", t3code: { databaseMigration: 84 } } },
  { status: 200, body: { version: nightly } },
])("refuses missing or mismatched release compatibility metadata: $status", ({ status, body }) =>
  Effect.gen(function* () {
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.includes("api.github.com")
                ? new Response(JSON.stringify(index))
                : new Response(JSON.stringify(body), { status }),
            ),
          ),
        ),
      ),
    );
    const found = yield* service.get({ spec: "nightly" }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
  }),
);

it.effect("pages past upstream tags and drafts, returning null for an unpublished channel", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          urls.push(request.url);
          const page = request.url.endsWith("page=1")
            ? Array.from({ length: 100 }, () => ({ tag_name: "v9.0.0" }))
            : [];
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify(page))),
          );
        }),
      ),
    );
    expect(yield* service.get({ spec: "nightly" })).toBeNull();
    expect(urls).toHaveLength(2);
  }),
);
