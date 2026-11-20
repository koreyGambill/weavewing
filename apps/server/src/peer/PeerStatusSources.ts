import { StatusSourceList } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../serverActivation.ts";
import * as StatusSources from "../statusSources/StatusSources.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * One pass: mirrors what each reachable linked environment shares. A peer that
 * does not answer keeps its last mirror, so a sleeping machine neither clears
 * nor raises alerts. A link that is gone, expired or refused drops its mirror.
 */
export const syncOnce = Effect.fn("PeerStatusSources.syncOnce")(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;
  const sources = yield* StatusSources.StatusSources;
  const listed = (yield* links.enabled) ? yield* links.list : [];
  const usable = new Set(
    listed
      .filter((link) => link.status === "reachable" || link.status === "unreachable")
      .map((link) => link.environmentId),
  );
  const stale = new Map(
    (yield* sources.list())
      .flatMap((source) => (source.origin ? [source.origin] : []))
      .filter((origin) => !usable.has(origin.environmentId))
      .map((origin) => [origin.environmentId, origin.label]),
  );
  for (const [environmentId, label] of stale)
    yield* sources.mirror({ environmentId, label, sources: [] });
  yield* Effect.forEach(
    listed.filter((link) => link.status === "reachable"),
    (link) =>
      client
        .call({
          environmentId: link.environmentId,
          tool: "t3_status_sources",
          arguments: {},
          limits: { runtimeMode: "approval-required", interactionMode: "default" },
          success: StatusSourceList,
        })
        .pipe(
          // One stalled peer must not hold up the next pass for the others.
          Effect.timeout("20 seconds"),
          Effect.flatMap((shared) =>
            sources.mirror({
              environmentId: link.environmentId,
              label: link.label,
              sources: shared,
            }),
          ),
          Effect.catch((cause) =>
            Effect.logDebug("Could not read a linked environment's status sources", {
              environmentId: link.environmentId,
              cause,
            }),
          ),
        ),
    { concurrency: 4, discard: true },
  );
});

export const layer = Layer.effectDiscard(
  forkParked(
    syncOnce().pipe(
      Effect.catch((cause) => Effect.logWarning("Could not sync linked status sources", { cause })),
      Effect.repeat(Schedule.spaced("60 seconds")),
    ),
  ),
);
