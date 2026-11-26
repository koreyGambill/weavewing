import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironments } from "../../state/environments";
import { evidenceList } from "../../state/evidence";
import { useEnvironmentsWithScope } from "../../state/session";
import type { EvidenceEnvironment, EvidenceFirstPages } from "./evidence.logic";

/** Each connected environment that records evidence and lets this connection read it. */
export function useEvidenceEnvironments(): ReadonlyArray<EvidenceEnvironment> {
  const { environments } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  return environments.flatMap((environment) =>
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.evidence === true &&
    readable.has(environment.environmentId)
      ? [{ environmentId: environment.environmentId, label: environment.label }]
      : [],
  );
}

export const NEEDS_QA_INPUT = { needsQa: true } as const;
export const ALL_LANDINGS_INPUT = {} as const;

// Keyed by the id list, so the sheet and its groups read the same first-page queries.
const firstPagesAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).map((environmentId) => {
      const needsQa = get(evidenceList({ environmentId, input: NEEDS_QA_INPUT }));
      const all = get(evidenceList({ environmentId, input: ALL_LANDINGS_INPUT }));
      return {
        needsQa: AsyncResult.getOrElse(needsQa, () => null),
        all: AsyncResult.getOrElse(all, () => null),
        failed: AsyncResult.isFailure(needsQa) || AsyncResult.isFailure(all),
      };
    }),
  ).pipe(Atom.withLabel(`mobile:evidence:first-pages:${environmentIdsKey}`)),
);

/** Every listed environment's first Needs QA and all-landings pages, in the same order. */
export function useEvidenceFirstPages(
  environments: ReadonlyArray<EvidenceEnvironment>,
): ReadonlyArray<EvidenceFirstPages & { readonly failed: boolean }> {
  return useAtomValue(
    firstPagesAtom(JSON.stringify(environments.map((environment) => environment.environmentId))),
  );
}
