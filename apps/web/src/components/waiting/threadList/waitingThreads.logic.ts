import type {
  EnvironmentId,
  Notification,
  ScopedThreadRef,
  WaitingCounts,
  WaitingItemKind,
  WaitingItemSummary,
} from "@t3tools/contracts";
import { notificationTab } from "@t3tools/client-runtime/state/notifications";

import { waitingStripSummary } from "../waitingStrip.logic";

/** The few shell fields the list reads, so streaming fields never reach it. */
export interface WaitingThreadSource {
  readonly environmentId: EnvironmentId;
  readonly id: ScopedThreadRef["threadId"];
  readonly title: string;
  /** ISO time of the thread's last change. */
  readonly updatedAt: string;
  readonly archivedAt: unknown;
  readonly waiting?: ReadonlyArray<WaitingItemSummary> | undefined;
  readonly waitingCounts?: WaitingCounts | undefined;
}

export interface WaitingThread {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly counts: ReadonlyArray<{ readonly kind: WaitingItemKind; readonly count: number }>;
  readonly discussing: number;
  readonly updatedAtMs: number;
}

export interface WaitingThreads {
  /** Threads with something waiting on the user, most recently changed first. */
  readonly waiting: ReadonlyArray<WaitingThread>;
  /** Threads where nothing waits on the user but something is being discussed. */
  readonly onAgent: ReadonlyArray<WaitingThread>;
}

export const NO_WAITING_THREADS: WaitingThreads = { waiting: [], onAgent: [] };

/**
 * Sorts the unarchived threads of environments with waiting cards on into those waiting on the
 * user and those only waiting on the agent. It decides from each thread's exact counts as the
 * strip does, so capped rows never change a number.
 */
export function selectWaitingThreads(
  threads: ReadonlyArray<WaitingThreadSource>,
  enabledEnvironmentIds: ReadonlyArray<EnvironmentId>,
): WaitingThreads {
  const waiting: WaitingThread[] = [];
  const onAgent: WaitingThread[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null || !enabledEnvironmentIds.includes(thread.environmentId)) {
      continue;
    }
    const summary = waitingStripSummary(thread.waiting, thread.waitingCounts);
    if (summary === null) continue;
    const entry: WaitingThread = {
      key: `${thread.environmentId}:${thread.id}`,
      ref: { environmentId: thread.environmentId, threadId: thread.id },
      title: thread.title,
      counts: summary.counts,
      discussing: summary.discussing,
      updatedAtMs: Date.parse(thread.updatedAt),
    };
    (summary.total > 0 ? waiting : onAgent).push(entry);
  }
  const newestFirst = (a: WaitingThread, b: WaitingThread) => b.updatedAtMs - a.updatedAtMs;
  return { waiting: waiting.sort(newestFirst), onAgent: onAgent.sort(newestFirst) };
}

const sameThread = (a: WaitingThread, b: WaitingThread) =>
  a.key === b.key &&
  a.title === b.title &&
  a.discussing === b.discussing &&
  a.updatedAtMs === b.updatedAtMs &&
  a.counts.length === b.counts.length &&
  a.counts.every(
    (entry, index) =>
      entry.kind === b.counts[index]!.kind && entry.count === b.counts[index]!.count,
  );

const sameList = (a: ReadonlyArray<WaitingThread>, b: ReadonlyArray<WaitingThread>) =>
  a.length === b.length && a.every((entry, index) => sameThread(entry, b[index]!));

export const sameWaitingThreads = (a: WaitingThreads, b: WaitingThreads) =>
  sameList(a.waiting, b.waiting) && sameList(a.onAgent, b.onAgent);

export interface WaitingAlert {
  readonly environmentId: EnvironmentId;
  readonly notification: Notification;
}

/** The most alerts the list shows; the Inbox holds the rest. */
export const WAITING_ALERTS_LIMIT = 5;

/**
 * Unread notifications in the Inbox tab that no thread owns, such as status sources and
 * automation failures, newest first. Thread-owned ones stay in the Inbox, which the list opens.
 */
export function selectWaitingAlerts(
  groups: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly items: ReadonlyArray<Notification>;
  }>,
  nowMs: number,
): ReadonlyArray<WaitingAlert> {
  return groups
    .flatMap(({ environmentId, items }) =>
      items
        .filter(
          (notification) =>
            notification.threadId === null &&
            notification.readAt === null &&
            notificationTab(notification, nowMs) === "inbox",
        )
        .map((notification) => ({ environmentId, notification })),
    )
    .sort((a, b) => b.notification.updatedAt.localeCompare(a.notification.updatedAt))
    .slice(0, WAITING_ALERTS_LIMIT);
}

/** The row's accessible name: what it counts and that it opens a list. */
export function waitingRowLabel(threads: number, unread: number): string {
  const parts = [
    threads > 0 ? `${threads} ${threads === 1 ? "thread" : "threads"} waiting on you` : null,
    unread > 0 ? `${unread} unread ${unread === 1 ? "notification" : "notifications"}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Waiting on you" : `Waiting on you: ${parts.join(", ")}`;
}

export interface WaitingInbox {
  readonly environmentId: EnvironmentId;
  /** Exact, from the stream's counts, never from its capped items. */
  readonly unreadCount: number;
  readonly items: ReadonlyArray<Notification>;
}

/**
 * What the row and its palette entry show, or null to hide both. Only environments with waiting
 * cards on take part, so turning the setting off hides the row whatever is unread; the Inbox
 * keeps its own entry points.
 */
export function waitingRowState(
  threads: WaitingThreads,
  inboxes: ReadonlyArray<WaitingInbox>,
  enabledEnvironmentIds: ReadonlyArray<EnvironmentId>,
): { readonly inboxes: ReadonlyArray<WaitingInbox>; readonly unread: number } | null {
  const enabled = inboxes.filter((inbox) => enabledEnvironmentIds.includes(inbox.environmentId));
  const unread = enabled.reduce((total, inbox) => total + inbox.unreadCount, 0);
  return threads.waiting.length > 0 || unread > 0 ? { inboxes: enabled, unread } : null;
}

/** Said in place of the list when only thread-owned notifications are unread. */
export function waitingListNote(
  threads: WaitingThreads,
  alerts: number,
  unread: number,
): string | null {
  return threads.waiting.length === 0 && threads.onAgent.length === 0 && alerts === 0 && unread > 0
    ? `${unread} unread in Inbox`
    : null;
}

/** Each connected machine's name, or null while only one is connected and names add nothing. */
export function machineLabels(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connected: boolean;
  }>,
): ReadonlyMap<EnvironmentId, string> | null {
  const connected = environments.filter((environment) => environment.connected);
  return connected.length > 1
    ? new Map(connected.map((environment) => [environment.environmentId, environment.label]))
    : null;
}
