// Weavewing sends no product analytics. Upstream call sites stay to keep merges clean; this
// replaces the delivery layer, reads no config, and never builds an identity.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AnalyticsService } from "./AnalyticsService.ts";

const discard = (..._args: ReadonlyArray<unknown>) => Effect.void;

export const layer = Layer.succeed(
  AnalyticsService,
  AnalyticsService.of({ record: discard, flush: Effect.void, recordOwners: discard }),
);
