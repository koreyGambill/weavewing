import {
  notificationTab,
  type NotificationInbox,
  type NotificationTab,
} from "@t3tools/client-runtime/state/notifications";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  Notification,
  NotificationAction,
  NotificationUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";

/** One connected environment that keeps an inbox, with its live stream's latest fold. */
export interface InboxEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Null until the stream's first snapshot. */
  readonly inbox: NotificationInbox | null;
  readonly failed: boolean;
  /** Whether this connection may mark and dismiss the environment's items. */
  readonly canUpdate: boolean;
}

export interface InboxItem {
  readonly environmentId: EnvironmentId;
  /** Set only when more than one environment is listed. */
  readonly environmentLabel: string | null;
  readonly notification: Notification;
}

export const INBOX_TABS: ReadonlyArray<{
  readonly value: NotificationTab;
  readonly label: string;
}> = [
  { value: "inbox", label: "Inbox" },
  { value: "snoozed", label: "Snoozed" },
  { value: "dismissed", label: "Dismissed" },
];

/**
 * A view's segment label. Inbox carries the server's exact unread count, which the header's
 * icon only hints at, and Snoozed how many wait.
 */
export function inboxTabLabel(
  tab: NotificationTab,
  counts: { readonly unread: number; readonly snoozed: number },
): { readonly label: string; readonly accessibilityLabel: string } {
  const label = INBOX_TABS.find((entry) => entry.value === tab)!.label;
  if (tab === "inbox" && counts.unread > 0)
    return {
      label: `${label} ${counts.unread}`,
      accessibilityLabel: `${label}, ${counts.unread} unread`,
    };
  if (tab === "snoozed" && counts.snoozed > 0)
    return {
      label: `${label} ${counts.snoozed}`,
      accessibilityLabel: `${label}, ${counts.snoozed}`,
    };
  return { label, accessibilityLabel: label };
}

export const INBOX_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 60 },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "after", minutes: 7 * 24 * 60 },
];

export const inboxItemKey = (item: Pick<InboxItem, "environmentId" | "notification">) =>
  `${item.environmentId}:${item.notification.id}`;

const newestFirst = (a: InboxItem, b: InboxItem) =>
  a.notification.updatedAt === b.notification.updatedAt
    ? b.notification.createdAt.localeCompare(a.notification.createdAt)
    : b.notification.updatedAt.localeCompare(a.notification.updatedAt);

/**
 * Every environment's items in one list, newest raise first, with the shown tab's rows and the
 * snoozed count for its tab label.
 */
export function inboxView(
  environments: ReadonlyArray<InboxEnvironment>,
  tab: NotificationTab,
  nowMs: number,
): {
  readonly all: ReadonlyArray<InboxItem>;
  readonly shown: ReadonlyArray<InboxItem>;
  readonly snoozedCount: number;
} {
  const labelled = environments.length > 1;
  const all = environments
    .flatMap((environment) =>
      (environment.inbox?.items ?? []).map((notification) => ({
        environmentId: environment.environmentId,
        environmentLabel: labelled ? environment.label : null,
        notification,
      })),
    )
    .sort(newestFirst);
  let snoozedCount = 0;
  const shown: InboxItem[] = [];
  for (const item of all) {
    const itemTab = notificationTab(item.notification, nowMs);
    if (itemTab === "snoozed") snoozedCount += 1;
    if (itemTab === tab) shown.push(item);
  }
  return { all, shown, snoozedCount };
}

/**
 * The clock the tabs read: a snooze-wake upsert can land before the minute ticks, so the
 * latest arrival also counts as now.
 */
export function inboxNow(environments: ReadonlyArray<InboxEnvironment>, clockMs: number): number {
  return Math.max(
    clockMs,
    ...environments.map((environment) => environment.inbox?.receivedAt ?? 0),
  );
}

/** The server's unread counts summed, with whether any stream is failing or still loading. */
export function inboxSignal(environments: ReadonlyArray<InboxEnvironment>): {
  readonly unread: number;
  readonly loading: boolean;
  readonly failed: boolean;
} {
  return {
    unread: environments.reduce(
      (total, environment) => total + (environment.inbox?.unreadCount ?? 0),
      0,
    ),
    loading: environments.some((environment) => environment.inbox === null && !environment.failed),
    failed: environments.some((environment) => environment.failed),
  };
}

/** The header button's spoken label; a failing stream's zero proves nothing, so it says so. */
export function inboxButtonLabel(signal: ReturnType<typeof inboxSignal>): string {
  if (signal.unread > 0) return `Inbox, ${signal.unread} unread`;
  return signal.failed ? "Inbox, could not load" : "Inbox";
}

/** The header badge's text, capped so it stays one short capsule. */
export function inboxBadgeText(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

/** The update request for one item, addressed to the environment that holds it. */
export function inboxUpdateRequest(
  item: Pick<InboxItem, "environmentId" | "notification">,
  action: NotificationAction,
): { readonly environmentId: EnvironmentId; readonly input: NotificationUpdateInput } {
  return {
    environmentId: item.environmentId,
    input: { ids: [item.notification.id], action },
  };
}

/** The environments Mark all read writes to: those with something unread that allow it. */
export function markAllReadEnvironmentIds(
  environments: ReadonlyArray<InboxEnvironment>,
): ReadonlyArray<EnvironmentId> {
  return environments.flatMap((environment) =>
    environment.canUpdate && (environment.inbox?.unreadCount ?? 0) > 0
      ? [environment.environmentId]
      : [],
  );
}

export interface InboxThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** A settled item action: done, or failed with words for the row (none when interrupted). */
export type InboxActionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string | null };

export function inboxActionOutcome(
  action: NotificationAction["type"],
  result: AtomCommandResult<unknown, unknown>,
): InboxActionOutcome {
  if (result._tag === "Success") return { ok: true };
  return {
    ok: false,
    error: isAtomCommandInterrupted(result)
      ? null
      : inboxActionError(action, inboxFailureMessage(squashAtomCommandFailure(result))),
  };
}

/**
 * Opening an item that points to a thread. An unread one is marked read first when the
 * environment allows it, as web does on open; a failed write keeps the user on the item with
 * its error. Without permission the thread opens and the item stays unread.
 */
export async function openInboxThread(
  item: Pick<InboxItem, "environmentId" | "notification">,
  canUpdate: boolean,
  markRead: () => Promise<InboxActionOutcome>,
): Promise<
  | { readonly _tag: "navigate"; readonly thread: InboxThreadTarget }
  | { readonly _tag: "stay"; readonly error: string | null }
> {
  const { threadId } = item.notification;
  if (threadId === null) return { _tag: "stay", error: null };
  if (canUpdate && item.notification.readAt === null) {
    const outcome = await markRead();
    if (!outcome.ok) return { _tag: "stay", error: outcome.error };
  }
  return { _tag: "navigate", thread: { environmentId: item.environmentId, threadId } };
}

/** Each action's button label, in web's words. */
export function inboxActionLabel(action: NotificationAction["type"]): string {
  switch (action) {
    case "read":
      return "Mark read";
    case "unread":
      return "Mark unread";
    case "snooze":
      return "Snooze";
    case "unsnooze":
      return "Unsnooze";
    case "dismiss":
      return "Dismiss";
    case "restore":
      return "Restore";
  }
}

/** The actions an item offers in its tab, in the order web's detail lists them. */
export function inboxItemActions(
  notification: Notification,
  tab: NotificationTab,
): ReadonlyArray<"snooze" | "unsnooze" | "dismiss" | "restore" | "read" | "unread"> {
  return [
    ...(tab === "snoozed" ? (["unsnooze"] as const) : tab === "inbox" ? (["snooze"] as const) : []),
    tab === "dismissed" ? "restore" : "dismiss",
    notification.readAt === null ? "read" : "unread",
  ];
}

/** A failed command's cause as words: an error's own message, or the value as text. */
export function inboxFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message !== "" ? cause.message : String(cause);
}

export function inboxActionError(action: NotificationAction["type"], message: string): string {
  return `Could not ${inboxActionLabel(action).toLowerCase()}: ${message}`;
}

/** What raised the item: the agent's thread, the automation's title, or a status source. */
export function inboxSourceLabel(
  notification: Notification,
  names: { readonly threadTitle: string | null; readonly taskTitle: string | null },
): string {
  const { source } = notification;
  if (source.kind === "agent") return `Agent · ${names.threadTitle ?? "thread"}`;
  if (source.kind === "status-source") return "Status source";
  return names.taskTitle ?? (source.kind === "review" ? "Review" : "Automation");
}

export const INBOX_SEVERITY_LABEL: Record<Notification["severity"], string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

/** The empty state for a tab, naming the next step. */
export function inboxEmptyCopy(
  tab: NotificationTab,
  environmentCount: number,
): { readonly title: string; readonly detail: string } {
  if (environmentCount === 0)
    return {
      title: "No notifications",
      detail: "Connect to a server that supports notifications.",
    };
  switch (tab) {
    case "inbox":
      return {
        title: "No notifications",
        detail: "Automations and agents post here when something needs you.",
      };
    case "snoozed":
      return {
        title: "Nothing snoozed",
        detail: "Snoozed notifications wait here and return to the inbox when their time comes.",
      };
    case "dismissed":
      return {
        title: "Nothing dismissed",
        detail: "Dismissed notifications land here, where Restore puts them back.",
      };
  }
}
