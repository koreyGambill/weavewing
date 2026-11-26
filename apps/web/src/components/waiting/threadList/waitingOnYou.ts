import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { useInboxEnvironments } from "../../../state/inbox";
import { waitingCardsEnvironmentIdsAtom } from "../../../state/threadQuestions";
import { environmentThreadShells } from "../../../state/threads";
import {
  NO_WAITING_THREADS,
  selectWaitingThreads,
  sameWaitingThreads,
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

/** What the "Waiting on you" row shows, and whether it shows at all. */
export function useWaitingOnYou() {
  const threads = useAtomValue(waitingThreadsAtom);
  const inboxes = useInboxEnvironments();
  const unread = inboxes.reduce((total, group) => total + (group.inbox?.unreadCount ?? 0), 0);
  return {
    threads,
    inboxes,
    unread,
    visible: threads.waiting.length > 0 || unread > 0,
  };
}
