import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";

/**
 * Each connected environment's scheduled tasks, for every environment this session can read.
 * It reads the same `scheduledTasksLive` member the Automations views read, so mounting it opens
 * one stream per environment and those views share it rather than opening their own.
 */
export const scheduledTasksByEnvironmentAtom = Atom.make((get) => {
  const byEnvironment = new Map<EnvironmentId, ReadonlyArray<ScheduledTask>>();
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (!sessionHasScope(session, AuthOrchestrationReadScope)) continue;
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const list = AsyncResult.getOrElse(result, () => null);
    if (list !== null) byEnvironment.set(environmentId, list.tasks);
  }
  return byEnvironment as ReadonlyMap<EnvironmentId, ReadonlyArray<ScheduledTask>>;
}).pipe(Atom.withLabel("web-scheduled-tasks-by-environment"));

/** Keeps every readable environment's scheduled-task stream open for the app's lifetime. */
export function startScheduledTasksSubscription(registry: AtomRegistry.AtomRegistry): () => void {
  return registry.mount(scheduledTasksByEnvironmentAtom);
}
