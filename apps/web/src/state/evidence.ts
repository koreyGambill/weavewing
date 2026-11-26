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

/** Returning to the window refetches evidence; the tools strip, always mounted, owns the listener. */
export function useReloadEvidenceOnReturn(enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Window focus happens outside React.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("focus", reloadEvidence);
    return () => window.removeEventListener("focus", reloadEvidence);
  }, [enabled]);
}

const evidenceChangeSignal = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const revision = AsyncResult.getOrElse(
      get(serverEnvironment.evidenceLive({ environmentId, input: {} })),
      () => 0,
    );
    return `${get(reloadAtom)}:${revision}`;
  }),
);
const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
  evidenceChangeSignal(environmentId);

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
/** The open thread's landings; dropped once no row reads them, so a thread switch ends the read. */
const evidenceThread = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "evidence:thread",
  tag: WS_METHODS.evidenceThread,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger,
});
export const evidenceCoverage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "evidence:coverage",
  tag: WS_METHODS.evidenceCoverage,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger,
});
export const evidenceSetQa = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "evidence:setQa",
  tag: WS_METHODS.evidenceSetQa,
});
/**
 * Lists the changes waiting for QA before a date, or dismisses the listed ones. The server's
 * evidence revision refetches what is being read, once per dismissal.
 */
export const evidenceBulkSetQa = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "evidence:bulkSetQa",
  tag: WS_METHODS.evidenceBulkSetQa,
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

/**
 * The landings a thread shows QA for, with `landingIds` read even when older than the newest page;
 * null `threadRef` reads nothing.
 */
export function useThreadEvidence(
  threadRef: ScopedThreadRef | null,
  landingIds: ReadonlyArray<string> = [],
) {
  const environmentId = useEvidenceEnvironment(threadRef);
  const query = useEnvironmentQuery(
    threadRef === null || environmentId === null
      ? null
      : evidenceThread({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            ...(landingIds.length === 0 ? {} : { landingIds: [...landingIds] }),
          },
        }),
  );
  return { ...query, supported: environmentId !== null, requested: new Set(landingIds) };
}
