import { EnvironmentId, StatusSourcesError, type StatusSource } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  statusEnvironmentResult,
  statusScreenView,
  statusItemPresentation,
  statusSourceStateText,
  statusStatePresentation,
  type StatusEnvironmentResult,
} from "./statusSources.logic";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");
const oldServer = EnvironmentId.make("old-server");
const LABELS = new Map([
  [laptop, "Laptop"],
  [desktop, "Desktop"],
  [oldServer, "Old server"],
]);

function source(overrides: Partial<StatusSource> = {}): StatusSource {
  return {
    config: {
      id: "ci",
      name: "CI",
      kind: "http-health",
      icon: "activity",
      intervalSeconds: 60,
      timeoutSeconds: 10,
      snoozedUntil: null,
      target: "https://ci.example.com/health",
      hasCredentials: false,
      shared: true,
    },
    latest: { source: "CI", state: "ok", summary: "HTTP 200", items: [] },
    lastTransition: null,
    ...overrides,
  };
}

const loaded = (sources: ReadonlyArray<StatusSource>): StatusEnvironmentResult => ({
  kind: "loaded",
  sources,
});

describe("statusStatePresentation", () => {
  it("gives each state its own label and the app's status color", () => {
    expect(statusStatePresentation("ok")).toMatchObject({
      label: "Passing",
      textClassName: "text-adaptive-emerald-700-300",
    });
    expect(statusStatePresentation("warn")).toMatchObject({
      label: "Warning",
      textClassName: "text-warning-foreground",
    });
    expect(statusStatePresentation("fail")).toMatchObject({
      label: "Failing",
      textClassName: "text-danger-foreground",
    });
    expect(statusStatePresentation("unknown")).toMatchObject({
      label: "Not run",
      textClassName: "text-foreground-muted",
    });
  });
});

describe("statusItemPresentation", () => {
  it("labels a switched-off check as disabled with a muted icon", () => {
    expect(statusItemPresentation({ state: "unknown", detail: " Disabled " })).toEqual({
      label: "Disabled",
      textClassName: "text-foreground-muted",
      tintColorClassName: "accent-foreground-muted",
      symbol: "circle.dashed",
    });
  });

  it("keeps the state's own presentation for other checks", () => {
    expect(statusItemPresentation({ state: "unknown", detail: "Queued" }).label).toBe("Not run");
    expect(statusItemPresentation({ state: "fail", detail: "disabled" }).label).toBe("Failing");
  });
});

describe("statusEnvironmentResult", () => {
  it("is loading until the subscription delivers its first list", () => {
    expect(statusEnvironmentResult(AsyncResult.initial(true))).toEqual({ kind: "loading" });
  });

  it("carries the delivered sources", () => {
    const sources = [source()];
    expect(statusEnvironmentResult(AsyncResult.success(sources))).toEqual(loaded(sources));
  });

  it("reports a failed subscription with the error's message", () => {
    const failure = AsyncResult.failure<ReadonlyArray<StatusSource>, StatusSourcesError>(
      Cause.fail(new StatusSourcesError({ operation: "subscribe" })),
    );
    expect(statusEnvironmentResult(failure)).toEqual({
      kind: "failed",
      message: "Status source operation failed.",
    });
  });

  it("falls back to a generic message when the failure has none", () => {
    expect(
      statusEnvironmentResult(
        AsyncResult.failure<ReadonlyArray<StatusSource>, string>(Cause.fail("boom")),
      ),
    ).toEqual({
      kind: "failed",
      message: "Could not load checks.",
    });
  });
});

describe("statusScreenView", () => {
  const environment = (environmentId: EnvironmentId, supported = true, permitted = true) => ({
    environmentId,
    label: LABELS.get(environmentId)!,
    supported,
    permitted,
  });

  it("has nothing to show without a connected environment", () => {
    expect(statusScreenView([], [])).toEqual({ kind: "no-environments" });
  });

  it("says the servers need updating when none of them serve status sources", () => {
    expect(statusScreenView([environment(laptop, false)], [])).toEqual({ kind: "unsupported" });
  });

  it("says access is missing, not that servers need updating, when a server supports them", () => {
    expect(
      statusScreenView([environment(laptop, true, false), environment(oldServer, false)], []),
    ).toEqual({ kind: "no-access" });
  });

  it("shows the empty state once every readable environment loaded no sources", () => {
    expect(
      statusScreenView([environment(laptop), environment(desktop)], [loaded([]), loaded([])]),
    ).toEqual({ kind: "no-sources" });
  });

  it("keeps the groups while any environment is still loading or failed", () => {
    const loading = statusScreenView(
      [environment(laptop), environment(desktop)],
      [loaded([]), { kind: "loading" }],
    );
    expect(loading.kind).toBe("groups");
    const failed = statusScreenView(
      [environment(laptop)],
      [{ kind: "failed", message: "Offline" }],
    );
    expect(failed).toEqual({
      kind: "groups",
      showEnvironmentHeaders: false,
      groups: [
        { environmentId: laptop, label: "Laptop", result: { kind: "failed", message: "Offline" } },
      ],
    });
  });

  it("groups by environment with headers only when more than one is shown", () => {
    const ci = source();
    const view = statusScreenView(
      [environment(laptop), environment(oldServer, false), environment(desktop)],
      [loaded([ci]), loaded([])],
    );
    expect(view).toEqual({
      kind: "groups",
      showEnvironmentHeaders: true,
      groups: [
        { environmentId: laptop, label: "Laptop", result: loaded([ci]) },
        { environmentId: desktop, label: "Desktop", result: loaded([]) },
      ],
    });
    expect(statusScreenView([environment(laptop)], [loaded([ci])])).toMatchObject({
      showEnvironmentHeaders: false,
    });
  });
});

describe("statusSourceStateText", () => {
  const now = Date.parse("2026-11-26T10:05:30.000Z");

  it("adds how long the state has held when the last transition led to it", () => {
    const failing = source({
      latest: { source: "CI", state: "fail", summary: "HTTP 500", items: [] },
      lastTransition: { from: "ok", to: "fail", at: "2026-11-26T10:00:00.000Z" },
    });
    expect(statusSourceStateText(failing, now)).toBe("Failing for 5m");
  });

  it("is the bare state before the server has seen the source change", () => {
    expect(statusSourceStateText(source(), now)).toBe("Passing");
    const superseded = source({
      lastTransition: { from: "ok", to: "fail", at: "2026-11-26T10:00:00.000Z" },
    });
    expect(statusSourceStateText(superseded, now)).toBe("Passing");
  });
});
