import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

// The server's evidence revision: every QA change, from any client or agent, moves it.
const evidenceChangeSignal = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    AsyncResult.getOrElse(
      get(serverEnvironment.evidenceLive({ environmentId, input: {} })),
      () => 0,
    ),
  ).pipe(Atom.withLabel(`mobile-evidence:revision:${environmentId}`)),
);

/** A thread's landings, refetched when the evidence revision moves and dropped once unread. */
export const evidenceThread = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-evidence:thread",
  tag: WS_METHODS.evidenceThread,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId }) => evidenceChangeSignal(environmentId),
});

/** One page of landings across threads, newest first, refetched when the revision moves. */
export const evidenceList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-evidence:list",
  tag: WS_METHODS.evidenceList,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId }) => evidenceChangeSignal(environmentId),
});

/** One landing with its changes and their QA, read while its card is open. */
export const evidenceGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-evidence:get",
  tag: WS_METHODS.evidenceGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId }) => evidenceChangeSignal(environmentId),
});

export const evidenceSetQa = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile-evidence:setQa",
  tag: WS_METHODS.evidenceSetQa,
});
