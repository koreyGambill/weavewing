import { useAtomValue } from "@effect/atom-react";
import { maxNotificationSeverity } from "@t3tools/client-runtime/state/notifications";
import { Atom } from "effect/reactivity";

import { useEnvironments } from "../../../state/environments";
import { useInboxEnvironments } from "../../../state/inbox";
import { waitingCardsEnvironmentIdsAtom } from "../../../state/threadQuestions";
import { environmentThreadShells } from "../../../state/threads";
import {
  NO_WAITING_THREADS,
  machineLabels,
  selectWaitingThreads,
  sameWaitingThreads,
  waitingRowState,
} from "./waitingThreads.logic";

/**
 * Threads waiting on the user, from the shells the thread list already streams. It reads the
 * quiet shells, so a running agent's ticks do not recompute it, and keeps its last value while
 * nothing it shows has changed.
 */
export const waitingThreadsAtom = Atom.make((get) => {
  const enabled = get(waitingCardsEnvironmentIdsAtom);
  const next =
    enabled.length === 0
      ? NO_WAITING_THREADS
      : selectWaitingThreads(get(environmentThreadShells.quietThreadShellsAtom), enabled);
  const previous = get.self<typeof next>();
  return previous._tag === "Some" && sameWaitingThreads(previous.value, next)
    ? previous.value
    : next;
}).pipe(Atom.withLabel("web-waiting-threads"));

/** What the "Waiting on you" row shows, and whether it and its palette entry show at all. */
export function useWaitingOnYou() {
  const threads = useAtomValue(waitingThreadsAtom);
  const enabled = useAtomValue(waitingCardsEnvironmentIdsAtom);
  const groups = useInboxEnvironments();
  const { environments } = useEnvironments();
  const row = waitingRowState(
    threads,
    groups.map((group) => ({
      environmentId: group.environment.environmentId,
      unreadCount: group.inbox?.unreadCount ?? 0,
      items: group.inbox?.items ?? [],
    })),
    enabled,
  );
  return {
    threads,
    inboxes: row?.inboxes ?? [],
    unread: row?.unread ?? 0,
    severity: maxNotificationSeverity(
      groups
        .filter((group) => enabled.includes(group.environment.environmentId))
        .map((group) => group.inbox?.maxUnreadSeverity ?? null),
    ),
    machines: machineLabels(
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connected: environment.connection.phase === "connected",
      })),
    ),
    visible: row !== null,
    /** Machines with waiting cards on; none means the feature is off everywhere. */
    enabledCount: enabled.length,
  };
}
