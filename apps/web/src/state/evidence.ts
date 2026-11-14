import {
  AuthOrchestrationReadScope,
  WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironment, usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useEnvironmentScope } from "./session";

const reloadAtom = Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel("evidence:reload"));

/** Refetches every evidence query being read: after a QA change, on window return, or on request. */
export function reloadEvidence() {
  appAtomRegistry.set(reloadAtom, appAtomRegistry.get(reloadAtom) + 1);
}

/** Returning to the window refetches evidence; the strip, always mounted, owns the listener. */
export function useReloadEvidenceOnReturn(enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Window focus happens outside React.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("focus", reloadEvidence);
    return () => window.removeEventListener("focus", reloadEvidence);
  }, [enabled]);
}

/**
 * Recording evidence raises an agent Inbox notification, and the notification contract carries no
 * dedupe key to clients, so any agent notification raise refetches evidence. No polling.
 */
const agentRaiseSignal = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const inbox = AsyncResult.getOrElse(
      get(serverEnvironment.notificationsLive({ environmentId, input: {} })),
      () => null,
    );
    const reload = get(reloadAtom);
    let raised = "";
    for (const item of inbox?.items ?? []) {
      if (item.source.kind === "agent" && item.updatedAt > raised) raised = item.updatedAt;
    }
    return `${reload}:${raised}`;
  }).pipe(Atom.withLabel(`evidence:agent-raise:${environmentId}`)),
);

const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
  agentRaiseSignal(environmentId);

export const evidenceList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "evidence:list",
  tag: WS_METHODS.evidenceList,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger,
});
export const evidenceGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "evidence:get",
  tag: WS_METHODS.evidenceGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger,
});
const evidenceCounts = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "evidence:counts",
  tag: WS_METHODS.evidenceCounts,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
  refreshTrigger,
});
export const evidenceSetQa = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "evidence:setQa",
  tag: WS_METHODS.evidenceSetQa,
});

/** The environment Evidence shows: the tools' thread's, else the primary one, if it records evidence. */
export function useEvidenceEnvironment(threadRef: ScopedThreadRef | null) {
  const primary = usePrimaryEnvironmentId();
  const environmentId = threadRef?.environmentId ?? primary;
  const environment = useEnvironment(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const supported =
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.evidence === true &&
    canRead;
  return supported ? environmentId : null;
}

export function useEvidenceCounts(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : evidenceCounts({ environmentId, input: {} }),
  );
}
