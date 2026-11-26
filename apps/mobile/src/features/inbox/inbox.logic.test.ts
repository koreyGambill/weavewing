import { EMPTY_NOTIFICATION_INBOX } from "@t3tools/client-runtime/state/notifications";
import {
  EnvironmentId,
  MonitoringFindingId,
  NotificationError,
  NotificationId,
  ScheduledTaskId,
  ThreadId,
  type Notification,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  inboxActionError,
  inboxBadgeText,
  inboxButtonLabel,
  inboxEmptyCopy,
  inboxFailureMessage,
  inboxItemActions,
  inboxNow,
  inboxSignal,
  inboxSourceLabel,
  inboxTabLabel,
  inboxUpdateRequest,
  inboxView,
  inboxActionOutcome,
  markAllReadEnvironmentIds,
  openInboxThread,
  type InboxActionOutcome,
  type InboxEnvironment,
} from "./inbox.logic";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const LAPTOP = EnvironmentId.make("env-laptop");
const SERVER = EnvironmentId.make("env-server");

const notification = (id: string, overrides: Partial<Notification> = {}): Notification => ({
  id: NotificationId.make(id),
  createdAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T10:00:00.000Z",
  severity: "info",
  title: `Notification ${id}`,
  source: { kind: "agent", threadId: ThreadId.make("thread-1") },
  threadId: ThreadId.make("thread-1"),
  projectId: null,
  readAt: null,
  dismissedAt: null,
  snoozedUntil: null,
  repeatCount: 0,
  ...overrides,
});

const environment = (
  environmentId: EnvironmentId,
  items: ReadonlyArray<Notification> | null,
  overrides: Partial<InboxEnvironment> = {},
): InboxEnvironment => ({
  environmentId,
  label: environmentId === LAPTOP ? "Laptop" : "Server",
  inbox:
    items === null
      ? null
      : {
          ...EMPTY_NOTIFICATION_INBOX,
          items,
          unreadCount: items.filter((item) => item.readAt === null).length,
        },
  failed: false,
  canUpdate: true,
  ...overrides,
});

describe("inboxView", () => {
  it("merges every environment's items newest raise first, breaking ties by creation", () => {
    const view = inboxView(
      [
        environment(LAPTOP, [
          notification("old", { updatedAt: "2026-11-26T08:00:00.000Z" }),
          notification("tie-older", {
            updatedAt: "2026-11-26T11:00:00.000Z",
            createdAt: "2026-11-26T07:00:00.000Z",
          }),
        ]),
        environment(SERVER, [
          notification("newest", { updatedAt: "2026-11-26T11:30:00.000Z" }),
          notification("tie-newer", {
            updatedAt: "2026-11-26T11:00:00.000Z",
            createdAt: "2026-11-26T09:00:00.000Z",
          }),
        ]),
      ],
      "inbox",
      NOW,
    );
    expect(view.shown.map((item) => item.notification.id)).toEqual([
      "newest",
      "tie-newer",
      "tie-older",
      "old",
    ]);
  });

  it("labels rows with their environment only when more than one is listed", () => {
    const one = inboxView([environment(LAPTOP, [notification("a")])], "inbox", NOW);
    expect(one.shown.map((item) => item.environmentLabel)).toEqual([null]);

    const two = inboxView(
      [environment(LAPTOP, [notification("a")]), environment(SERVER, [notification("b")])],
      "inbox",
      NOW,
    );
    expect(
      two.shown.map((item) => [item.environmentId, item.notification.id, item.environmentLabel]),
    ).toEqual([
      [LAPTOP, "a", "Laptop"],
      [SERVER, "b", "Server"],
    ]);
  });

  it("files items under inbox, snoozed and dismissed, and counts the snoozed", () => {
    const environments = [
      environment(LAPTOP, [
        notification("open"),
        notification("woken", { snoozedUntil: "2026-11-26T11:00:00.000Z" }),
        notification("sleeping", { snoozedUntil: "2026-11-27T09:00:00.000Z" }),
        notification("gone", {
          dismissedAt: "2026-11-26T11:00:00.000Z",
          snoozedUntil: "2026-11-27T09:00:00.000Z",
        }),
      ]),
    ];
    const ids = (tab: "inbox" | "snoozed" | "dismissed") =>
      inboxView(environments, tab, NOW).shown.map((item) => item.notification.id);
    expect(ids("inbox")).toEqual(["open", "woken"]);
    expect(ids("snoozed")).toEqual(["sleeping"]);
    expect(ids("dismissed")).toEqual(["gone"]);
    expect(inboxView(environments, "inbox", NOW).snoozedCount).toBe(1);
  });

  it("lists nothing while every stream is still loading", () => {
    expect(inboxView([environment(LAPTOP, null)], "inbox", NOW).shown).toEqual([]);
  });
});

describe("inboxNow", () => {
  it("takes the latest arrival when it is past the minute clock", () => {
    const arrived = { ...EMPTY_NOTIFICATION_INBOX, receivedAt: NOW + 30_000 };
    expect(inboxNow([environment(LAPTOP, [], { inbox: arrived })], NOW)).toBe(NOW + 30_000);
    expect(inboxNow([environment(LAPTOP, [])], NOW)).toBe(NOW);
  });
});

describe("inboxSignal", () => {
  it("sums the server's unread counts, not the loaded rows", () => {
    // The snapshot window holds fewer rows than the server counts, so the rows undercount.
    const withCount = (base: InboxEnvironment, unreadCount: number): InboxEnvironment => ({
      ...base,
      inbox: { ...base.inbox!, unreadCount },
    });
    const signal = inboxSignal([
      withCount(environment(LAPTOP, [notification("a"), notification("b")]), 250),
      withCount(
        environment(SERVER, [
          notification("c"),
          notification("d", { readAt: "2026-11-26T11:00:00.000Z" }),
        ]),
        4,
      ),
    ]);
    expect(signal).toEqual({ unread: 254, loading: false, failed: false });
  });

  it("puts the exact unread count on the Inbox view and the waiting count on Snoozed", () => {
    expect(inboxTabLabel("inbox", { unread: 254, snoozed: 2 })).toEqual({
      label: "Inbox 254",
      accessibilityLabel: "Inbox, 254 unread",
    });
    expect(inboxTabLabel("snoozed", { unread: 254, snoozed: 2 }).label).toBe("Snoozed 2");
    expect(inboxTabLabel("inbox", { unread: 0, snoozed: 0 }).label).toBe("Inbox");
    expect(inboxTabLabel("dismissed", { unread: 9, snoozed: 9 }).label).toBe("Dismissed");
  });

  it("reports a loading stream and a failing one apart", () => {
    expect(inboxSignal([environment(LAPTOP, null)])).toMatchObject({
      loading: true,
      failed: false,
    });
    expect(inboxSignal([environment(LAPTOP, null, { failed: true })])).toMatchObject({
      unread: 0,
      loading: false,
      failed: true,
    });
  });

  it("speaks the count, and a failing stream instead of a false zero", () => {
    expect(inboxButtonLabel({ unread: 4, loading: false, failed: false })).toBe("Inbox, 4 unread");
    expect(inboxButtonLabel({ unread: 0, loading: false, failed: false })).toBe("Inbox");
    expect(inboxButtonLabel({ unread: 0, loading: false, failed: true })).toBe(
      "Inbox, could not load",
    );
  });

  it("badges a positive count and caps it", () => {
    expect(inboxBadgeText(0)).toBeNull();
    expect(inboxBadgeText(7)).toBe("7");
    expect(inboxBadgeText(140)).toBe("99+");
  });
});

describe("action routing", () => {
  it("addresses an item's update to the environment that holds it", () => {
    const [laptopItem, serverItem] = inboxView(
      [
        environment(LAPTOP, [notification("same-id", { updatedAt: "2026-11-26T11:00:00.000Z" })]),
        environment(SERVER, [notification("same-id")]),
      ],
      "inbox",
      NOW,
    ).shown;
    expect(inboxUpdateRequest(serverItem!, { type: "dismiss" })).toEqual({
      environmentId: SERVER,
      input: { ids: ["same-id"], action: { type: "dismiss" } },
    });
    expect(
      inboxUpdateRequest(laptopItem!, { type: "snooze", until: "2026-11-27T09:00:00.000Z" }),
    ).toEqual({
      environmentId: LAPTOP,
      input: { ids: ["same-id"], action: { type: "snooze", until: "2026-11-27T09:00:00.000Z" } },
    });
  });

  it("marks all read only where something is unread and the connection may update", () => {
    expect(
      markAllReadEnvironmentIds([
        environment(LAPTOP, [notification("a")]),
        environment(SERVER, [notification("b", { readAt: "2026-11-26T11:00:00.000Z" })]),
        environment(EnvironmentId.make("env-guest"), [notification("c")], { canUpdate: false }),
        environment(EnvironmentId.make("env-loading"), null),
      ]),
    ).toEqual([LAPTOP]);
  });

  it("marks an unread item read before opening its thread in its own environment", async () => {
    const order: string[] = [];
    const outcome = await openInboxThread(
      { environmentId: SERVER, notification: notification("a") },
      true,
      async () => {
        order.push("read");
        return { ok: true };
      },
    );
    expect(order).toEqual(["read"]);
    expect(outcome).toEqual({
      _tag: "navigate",
      thread: { environmentId: SERVER, threadId: "thread-1" },
    });
  });

  it("stays on the item with the error when marking it read fails", async () => {
    const failed = inboxActionOutcome(
      "read",
      AsyncResult.failure(Cause.fail(new NotificationError({ operation: "update" }))),
    );
    const outcome = await openInboxThread(
      { environmentId: SERVER, notification: notification("a") },
      true,
      async () => failed,
    );
    expect(outcome).toEqual({
      _tag: "stay",
      error: "Could not mark read: Notification update failed.",
    });
  });

  it("opens the thread without writing when the item is read or the user may not update", async () => {
    const markRead = async (): Promise<InboxActionOutcome> => {
      throw new Error("must not write");
    };
    const read = notification("b", { readAt: "2026-11-26T11:00:00.000Z" });
    expect(
      (await openInboxThread({ environmentId: LAPTOP, notification: read }, true, markRead))._tag,
    ).toBe("navigate");
    expect(
      (
        await openInboxThread(
          { environmentId: LAPTOP, notification: notification("c") },
          false,
          markRead,
        )
      )._tag,
    ).toBe("navigate");
  });
});

describe("inboxActionOutcome", () => {
  it("reports success, a failure's words, and an interrupt with none", () => {
    expect(inboxActionOutcome("dismiss", AsyncResult.success({ items: [] }))).toEqual({ ok: true });
    expect(inboxActionOutcome("dismiss", AsyncResult.failure(Cause.fail("socket closed")))).toEqual(
      { ok: false, error: "Could not dismiss: socket closed" },
    );
    expect(inboxActionOutcome("dismiss", AsyncResult.failure(Cause.interrupt()))).toEqual({
      ok: false,
      error: null,
    });
  });
});

describe("item actions", () => {
  it("offers web's actions for each view, with the reverse of each way out", () => {
    const unread = notification("a");
    const read = notification("b", { readAt: "2026-11-26T11:00:00.000Z" });
    expect(inboxItemActions(unread, "inbox")).toEqual(["snooze", "dismiss", "read"]);
    expect(inboxItemActions(read, "snoozed")).toEqual(["unsnooze", "dismiss", "unread"]);
    expect(inboxItemActions(read, "dismissed")).toEqual(["restore", "unread"]);
  });

  it("names a failed action and its cause", () => {
    expect(
      inboxActionError(
        "dismiss",
        inboxFailureMessage(new NotificationError({ operation: "update" })),
      ),
    ).toBe("Could not dismiss: Notification update failed.");
    expect(inboxActionError("read", inboxFailureMessage("socket closed"))).toBe(
      "Could not mark read: socket closed",
    );
  });
});

describe("inboxSourceLabel", () => {
  it("names the thread, automation, review or status source that raised the item", () => {
    const names = { threadTitle: "Fix the build", taskTitle: "Nightly sweep" };
    const task = ScheduledTaskId.make("task-1");
    expect(inboxSourceLabel(notification("a"), names)).toBe("Agent · Fix the build");
    expect(inboxSourceLabel(notification("a"), { threadTitle: null, taskTitle: null })).toBe(
      "Agent · thread",
    );
    expect(
      inboxSourceLabel(
        notification("b", { source: { kind: "automation", scheduledTaskId: task, runId: "r" } }),
        names,
      ),
    ).toBe("Nightly sweep");
    expect(
      inboxSourceLabel(
        notification("c", {
          source: {
            kind: "review",
            scheduledTaskId: task,
            runId: "r",
            findingId: MonitoringFindingId.make("finding-1"),
          },
        }),
        { threadTitle: null, taskTitle: null },
      ),
    ).toBe("Review");
    expect(
      inboxSourceLabel(
        notification("d", { source: { kind: "status-source", sourceId: "ci" } }),
        names,
      ),
    ).toBe("Status source");
  });
});

describe("inboxEmptyCopy", () => {
  it("names the next step, and says when no server supports notifications", () => {
    expect(inboxEmptyCopy("inbox", 1).detail).toBe(
      "Automations and agents post here when something needs you.",
    );
    expect(inboxEmptyCopy("dismissed", 2).title).toBe("Nothing dismissed");
    expect(inboxEmptyCopy("snoozed", 0).detail).toBe(
      "Connect to a server that supports notifications.",
    );
  });
});
