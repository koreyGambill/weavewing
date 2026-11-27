import type {
  EnvironmentId,
  Notification,
  NotificationId,
  ThreadId,
  WaitingCounts,
  WaitingItemSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  WAITING_ALERTS_LIMIT,
  selectWaitingAlerts,
  selectWaitingThreads,
  type WaitingThreadSource,
} from "./waitingThreads.logic";

const ENV = "env-a" as EnvironmentId;
const OTHER_ENV = "env-b" as EnvironmentId;

const counts = (partial: Partial<WaitingCounts>): WaitingCounts => ({
  question: 0,
  qa: 0,
  task: 0,
  discussing: 0,
  liveQuestions: 0,
  live: 0,
  ...partial,
});

const row = (
  kind: WaitingItemSummary["kind"],
  ref: string,
  state: WaitingItemSummary["state"] = "open",
): WaitingItemSummary => ({ kind, ref, key: ref, title: ref, state });

const thread = (
  id: string,
  updatedAtMs: number,
  waitingCounts: WaitingCounts | undefined,
  extra: Partial<WaitingThreadSource> = {},
): WaitingThreadSource => ({
  environmentId: ENV,
  id: id as ThreadId,
  title: `Thread ${id}`,
  updatedAt: new Date(updatedAtMs).toISOString(),
  archivedAt: null,
  waitingCounts,
  ...extra,
});

const ids = (entries: ReadonlyArray<{ readonly ref: { readonly threadId: string } }>) =>
  entries.map((entry) => entry.ref.threadId);

describe("selectWaitingThreads", () => {
  it("counts threads from exact counts, newest change first, whatever the listed rows say", () => {
    const result = selectWaitingThreads(
      [
        thread("old", 1, counts({ qa: 40, live: 40 }), { waiting: [row("qa", "QA1")] }),
        thread("new", 3, counts({ question: 1, task: 2, live: 3 })),
        // Listed rows that the exact counts no longer count do not make a thread wait.
        thread("stale", 2, counts({}), { waiting: [row("task", "T1")] }),
      ],
      [ENV],
    );
    expect(ids(result.waiting)).toEqual(["new", "old"]);
    expect(result.waiting[1]!.counts).toEqual([{ kind: "qa", count: 40 }]);
    expect(result.waiting[0]!.counts).toEqual([
      { kind: "question", count: 1 },
      { kind: "task", count: 2 },
    ]);
  });

  it("lists a thread only being discussed as waiting on the agent, not on the user", () => {
    const result = selectWaitingThreads(
      [thread("talk", 1, counts({ discussing: 1, live: 1 }))],
      [ENV],
    );
    expect(result.waiting).toEqual([]);
    expect(ids(result.onAgent)).toEqual(["talk"]);
  });

  it("reads counts an older build wrote as the strip does: rows stand in for discussions", () => {
    const older: WaitingCounts = { question: 0, qa: 0, task: 0 };
    const result = selectWaitingThreads(
      [
        thread("older", 1, older, { waiting: [row("question", "Q1", "discussing")] }),
        thread("none", 2, undefined, { waiting: [row("task", "T1")] }),
      ],
      [ENV],
    );
    expect(result.waiting).toEqual([]);
    expect(ids(result.onAgent)).toEqual(["older"]);
    expect(result.onAgent[0]!.discussing).toBe(1);
  });

  it("leaves out archived threads and environments with waiting cards off", () => {
    const result = selectWaitingThreads(
      [
        thread("archived", 1, counts({ qa: 1 }), { archivedAt: "2026-01-01T00:00:00.000Z" }),
        thread("off", 1, counts({ qa: 1 }), { environmentId: OTHER_ENV }),
        thread("on", 1, counts({ qa: 1 })),
      ],
      [ENV],
    );
    expect(ids(result.waiting)).toEqual(["on"]);
  });
});

const notification = (id: string, partial: Partial<Notification> = {}): Notification => ({
  id: id as NotificationId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  severity: "warning",
  title: `Alert ${id}`,
  source: { kind: "status-source", sourceId: "ci" },
  threadId: null,
  projectId: null,
  readAt: null,
  dismissedAt: null,
  snoozedUntil: null,
  repeatCount: 0,
  ...partial,
});

describe("selectWaitingAlerts", () => {
  const now = Date.parse("2026-01-02T00:00:00.000Z");

  it("keeps unread inbox alerts no thread owns, newest first", () => {
    const alerts = selectWaitingAlerts(
      [
        {
          environmentId: ENV,
          items: [
            notification("older", { updatedAt: "2026-01-01T01:00:00.000Z" }),
            notification("thread", { threadId: "t1" as ThreadId }),
            notification("read", { readAt: "2026-01-01T02:00:00.000Z" }),
            notification("dismissed", { dismissedAt: "2026-01-01T02:00:00.000Z" }),
            notification("snoozed", { snoozedUntil: "2026-01-03T00:00:00.000Z" }),
            notification("woke", {
              snoozedUntil: "2026-01-01T12:00:00.000Z",
              updatedAt: "2026-01-01T00:30:00.000Z",
            }),
          ],
        },
        {
          environmentId: OTHER_ENV,
          items: [notification("newer", { updatedAt: "2026-01-01T03:00:00.000Z" })],
        },
      ],
      now,
    );
    expect(alerts.map((alert) => alert.notification.id)).toEqual(["newer", "older", "woke"]);
    expect(alerts[0]!.environmentId).toBe(OTHER_ENV);
  });

  it("shows at most the limit; the Inbox holds the rest", () => {
    const items = Array.from({ length: WAITING_ALERTS_LIMIT + 2 }, (_, index) =>
      notification(`n${index}`),
    );
    expect(selectWaitingAlerts([{ environmentId: ENV, items }], now)).toHaveLength(
      WAITING_ALERTS_LIMIT,
    );
  });
});
