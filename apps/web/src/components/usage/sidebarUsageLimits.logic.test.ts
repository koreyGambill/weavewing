import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { sidebarLimitReading } from "./sidebarUsageLimits.logic";

const checkedAt = "2026-11-19T15:00:00Z";
const session: ServerProviderUsageWindow = {
  id: "session",
  kind: "session",
  label: "Session",
  usedPercent: 10,
};
const weekly: ServerProviderUsageWindow = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 75,
};

it("prefers the account-wide weekly window and expires it an hour after the reading", () => {
  expect(
    sidebarLimitReading({
      checkedAt,
      windows: [session, { ...weekly, id: "scoped", modelIds: ["special"] }, weekly],
    }),
  ).toEqual({ window: weekly, deadline: Date.UTC(2026, 10, 19, 16) });
  expect(sidebarLimitReading({ checkedAt, windows: [session] })?.window).toBe(session);
});

it("withholds readings when their timestamp is invalid or the subscription is unreadable", () => {
  expect(sidebarLimitReading({ checkedAt: "invalid", windows: [weekly] })).toBeNull();
  expect(sidebarLimitReading({ checkedAt, windows: [] })).toBeNull();
  expect(
    sidebarLimitReading({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } }),
  ).toBeNull();
});
