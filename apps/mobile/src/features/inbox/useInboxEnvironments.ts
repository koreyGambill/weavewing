import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import type { InboxEnvironment } from "./inbox.logic";

// Keyed by the id list, so the same environments share one atom and every stream stays live.
const inboxResultsAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).map((environmentId) => ({
      result: get(serverEnvironment.notificationsLive({ environmentId, input: {} })),
      canUpdate: get(serverEnvironment.updateNotifications.permissionAtom(environmentId)),
    })),
  ).pipe(Atom.withLabel(`mobile:inbox:${environmentIdsKey}`)),
);

/** Each connected environment that keeps an inbox and lets this connection read it. */
export function useInboxEnvironments(): ReadonlyArray<InboxEnvironment> {
  const { environments } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.notifications === true &&
      readable.has(environment.environmentId),
  );
  const results = useAtomValue(
    inboxResultsAtom(JSON.stringify(connected.map((environment) => environment.environmentId))),
  );
  return connected.map((environment, index) => {
    const { result, canUpdate } = results[index]!;
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      inbox: AsyncResult.getOrElse(result, () => null),
      failed: AsyncResult.isFailure(result),
      canUpdate,
    };
  });
}
