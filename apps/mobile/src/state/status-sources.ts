import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/** An environment's status sources, pushed again whenever one changes; dropped once unread. */
const statusSources = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mobile-status-sources:subscribe",
  tag: WS_METHODS.statusSourcesSubscribe,
  idleTtlMs: 0,
});

/** The status sources of several environments, keyed by their ids joined with newlines. */
export const statusSourcesForEnvironments = Atom.family((key: string) =>
  Atom.make((get) =>
    key === ""
      ? []
      : (key.split("\n") as EnvironmentId[]).map((environmentId) =>
          get(statusSources({ environmentId, input: {} })),
        ),
  ).pipe(Atom.withLabel(`mobile-status-sources:${key}`)),
);
