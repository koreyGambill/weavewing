import type { StatusSource, StatusState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createStatusSourceNotificationGate } from "./statusSourceNotifications.logic";

function source(
  from: StatusState,
  to: StatusState,
  at: string,
  snoozedUntil: string | null = null,
): StatusSource {
  return {
    config: {
      id: "health",
      name: "Health",
      kind: "http-health",
      icon: "activity",
      intervalSeconds: 60,
      timeoutSeconds: 10,
      target: "http://localhost/health",
      hasCredentials: false,
      shared: true,
      snoozedUntil,
    },
    latest: { source: "health", state: to, summary: to, items: [] },
    lastTransition: { from, to, at },
  };
}

describe("status source notifications", () => {
  it("suppresses existing transitions, duplicate snapshots, and reconnect snapshots", () => {
    const gate = createStatusSourceNotificationGate();
    const initial = source("ok", "fail", "2026-01-01T00:00:00Z");
    expect(gate.observe([initial], 0)).toEqual([]);
    expect(gate.observe([{ ...initial }], 0)).toEqual([]);
    const recovered = source("fail", "ok", "2026-01-01T00:01:00Z");
    expect(gate.observe([recovered], 0)).toEqual([recovered]);
    expect(gate.observe([{ ...recovered }], 0)).toEqual([]);
    const reconnected = createStatusSourceNotificationGate();
    expect(reconnected.observe([recovered], 0)).toEqual([]);
  });

  it("only presents failures from OK and recovery, and never replays snoozed transitions", () => {
    const gate = createStatusSourceNotificationGate();
    gate.observe([source("unknown", "ok", "2026-01-01T00:00:00Z")], 0);
    const warning = source("ok", "warn", "2026-01-01T00:01:00Z");
    expect(gate.observe([warning], 0)).toEqual([warning]);
    expect(gate.observe([source("warn", "fail", "2026-01-01T00:02:00Z")], 0)).toEqual([]);
    const quiet = source("fail", "ok", "2026-01-01T00:03:00Z", "2026-01-01T01:00:00Z");
    expect(gate.observe([quiet], 0)).toEqual([]);
    expect(
      gate.observe([{ ...quiet, config: { ...quiet.config, snoozedUntil: null } }], 0),
    ).toEqual([]);
    const failed = source("ok", "fail", "2026-01-01T00:04:00Z");
    expect(gate.observe([failed], 0)).toEqual([failed]);
    expect(gate.observe([source("fail", "unknown", "2026-01-01T00:05:00Z")], 0)).toEqual([]);
    const expired = source("ok", "fail", "2026-01-01T01:00:00Z", "2026-01-01T01:00:00Z");
    expect(gate.observe([expired], Date.parse("2026-01-01T01:00:00Z"))).toEqual([expired]);
  });
});
