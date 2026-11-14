import { RegistryContext } from "@effect/atom-react";
import { WS_METHODS, type MessageFollowUpUpdateInput } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { subscribeDocumentReturn } from "../lib/documentActivity";

const localChanges = Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel("followUps:local-changes"));

// Other devices' flags have no stream, so a return to the window refetches instead.
const refreshSignal = Atom.make((get) => {
  let returns = 0;
  get.addFinalizer(subscribeDocumentReturn(() => get.setSelf(`${get(localChanges)}:${++returns}`)));
  return `${get(localChanges)}:${returns}`;
}).pipe(Atom.withLabel("followUps:refresh"));

/** Rows remount while the timeline scrolls, so the cache outlives them briefly. */
export const messageFollowUpsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "followUps:list",
  tag: WS_METHODS.messageFollowUpsList,
  staleTimeMs: 10_000,
  idleTtlMs: 60_000,
  refreshTrigger: () => refreshSignal,
});

export const messageFollowUpsUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "followUps:update",
  tag: WS_METHODS.messageFollowUpsUpdate,
});

/** Runs a follow-up change, then refetches every follow-up list this client shows. */
export function useMessageFollowUpUpdate() {
  const registry = useContext(RegistryContext);
  return async (environmentId: EnvironmentId, input: MessageFollowUpUpdateInput) => {
    const result = await runAtomCommand(
      registry,
      messageFollowUpsUpdate,
      { environmentId, input },
      { label: messageFollowUpsUpdate.label, reportFailure: true, reportDefect: true },
    );
    registry.set(localChanges, registry.get(localChanges) + 1);
    return result;
  };
}
