import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectLimitAccounts, type LimitPresentations } from "@t3tools/shared/usageLimits";
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

function duplicateReadings(
  first: ServerProvider["usageLimits"],
  second: ServerProvider["usageLimits"],
) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "account@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
  };
  const presentations: LimitPresentations = new Map(
    [first, second].map((usageLimits, index) => [
      EnvironmentId.make(`fixture-${index}`),
      {
        entry: { target: { label: `Fixture ${index}` } },
        serverConfig: { providers: [{ ...provider, usageLimits }] },
      },
    ]),
  );
  return collectLimitAccounts(presentations, {
    includeUnavailable: true,
    preferWindowObservation: true,
  }).map(({ limits }) => sidebarLimitReading(limits));
}

it("prefers a valid duplicate reading over an earlier invalid reading", () => {
  expect(
    duplicateReadings(
      { checkedAt: "invalid", windows: [weekly] },
      { checkedAt, windows: [weekly] },
    ),
  ).toEqual([{ window: weekly, deadline: Date.UTC(2026, 10, 19, 16) }]);
});

it("uses the newest weekly observation even when another report has a later session update", () => {
  const earlierWeekly = { ...weekly, observedAt: "2026-11-19T13:00:00Z" };
  const newerWeekly = { ...weekly, usedPercent: 90, observedAt: "2026-11-19T14:00:00Z" };
  expect(sidebarLimitReading({ checkedAt, windows: [session, earlierWeekly] })?.deadline).toBe(
    Date.UTC(2026, 10, 19, 14),
  );
  expect(
    duplicateReadings(
      { checkedAt, windows: [session, earlierWeekly] },
      { checkedAt: "2026-11-19T14:00:00Z", windows: [newerWeekly] },
    ),
  ).toEqual([{ window: newerWeekly, deadline: Date.UTC(2026, 10, 19, 15) }]);
});
