import { expect, it } from "@effect/vitest";
import { EnvironmentId, type PeerLinkSummary, type StatusSource } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as StatusSources from "../statusSources/StatusSources.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { syncOnce } from "./PeerStatusSources.ts";

const awake = EnvironmentId.make("environment:awake");
const asleep = EnvironmentId.make("environment:asleep");
const revoked = EnvironmentId.make("environment:revoked");
const link = (environmentId: EnvironmentId, status: PeerLinkSummary["status"]) =>
  ({
    environmentId,
    label: environmentId,
    urls: [],
    access: "read-only",
    linkedAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(0),
    lastReachedAt: null,
    lastError: null,
    status,
  }) satisfies PeerLinkSummary;
const mirrorOf = (environmentId: EnvironmentId) =>
  ({ origin: { environmentId, label: environmentId } }) as unknown as StatusSource;
const shared = [{ config: { id: "disk" } }] as unknown as ReadonlyArray<StatusSource>;

it.effect("mirrors reachable links, keeps a sleeping one, and drops a refused or removed one", () =>
  Effect.gen(function* () {
    const listed = yield* Ref.make([
      link(awake, "reachable"),
      link(asleep, "unreachable"),
      link(revoked, "unauthorized"),
    ]);
    const mirrors = yield* Ref.make<ReadonlyArray<readonly [EnvironmentId, number]>>([]);
    const layer = Layer.mergeAll(
      Layer.mock(PeerLinks.PeerLinks)({ enabled: Effect.succeed(true), list: Ref.get(listed) }),
      Layer.mock(PeerMcpClient.PeerMcpClient)({
        call: () => Effect.succeed(shared) as never,
      }),
      Layer.mock(StatusSources.StatusSources)({
        list: () => Effect.succeed([mirrorOf(awake), mirrorOf(asleep), mirrorOf(revoked)]),
        mirror: ({ environmentId, sources }) =>
          Ref.update(mirrors, (all) => [...all, [environmentId, sources.length] as const]),
      }),
    );
    const pass = syncOnce().pipe(Effect.provide(layer));
    yield* pass;
    expect(yield* Ref.getAndSet(mirrors, [])).toEqual([
      [revoked, 0],
      [awake, 1],
    ]);
    yield* Ref.set(listed, [link(asleep, "unreachable")]);
    yield* pass;
    expect(yield* Ref.get(mirrors)).toEqual([
      [awake, 0],
      [revoked, 0],
    ]);
  }),
);
