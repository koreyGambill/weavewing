import type { EnvironmentId, ScheduledTaskSummary } from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

/**
 * Each connected environment's scheduled-task summaries, for every environment whose grant allows
 * them. A summary names a task, its target thread and whether it is paused; full records stay
 * with the Automations views, which open `scheduledTasksLive` while they are shown.
 */
export const scheduledTaskSummariesByEnvironmentAtom = Atom.make((get) => {
  const summaries = serverEnvironment.scheduledTaskSummariesLive;
  const byEnvironment = new Map<EnvironmentId, ReadonlyArray<ScheduledTaskSummary>>();
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    if (!get(summaries.permissionAtom(environmentId))) continue;
    const list = AsyncResult.getOrElse(get(summaries({ environmentId, input: {} })), () => null);
    if (list !== null) byEnvironment.set(environmentId, list.tasks);
  }
  return byEnvironment as ReadonlyMap<EnvironmentId, ReadonlyArray<ScheduledTaskSummary>>;
}).pipe(Atom.withLabel("web-scheduled-task-summaries-by-environment"));

/** Keeps every permitted environment's summary stream open for the app's lifetime. */
export function startScheduledTasksSubscription(registry: AtomRegistry.AtomRegistry): () => void {
  return registry.mount(scheduledTaskSummariesByEnvironmentAtom);
}
