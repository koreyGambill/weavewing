import { describe, expect, it } from "vite-plus/test";
import type { StatusItem, StatusState } from "@t3tools/contracts";

import {
  groupStatusItems,
  sourceDefaultExpanded,
  sourceExpanded,
  statusItemCounts,
} from "./statusSources.logic";

const items: StatusItem[] = [
  { name: "disabled", state: "unknown", detail: "disabled" },
  { name: "healthy", state: "ok" },
  { name: "warning", state: "warn" },
  { name: "failed", state: "fail" },
  { name: "unavailable", state: "unknown" },
  { name: "also healthy", state: "ok" },
];

describe("status source presentation", () => {
  it("sorts attention first, keeps unrun checks visible and groups only disabled checks, and preserves peer order", () => {
    const original = [...items];
    const { active, inactive } = groupStatusItems(items);
    expect(active.map((item) => item.name)).toEqual([
      "failed",
      "warning",
      "healthy",
      "also healthy",
      "unavailable",
    ]);
    expect(inactive.map((item) => item.name)).toEqual(["disabled"]);
    expect(items).toEqual(original);
    expect(statusItemCounts(items)).toBe("1 fail · 1 warn · 2 ok · 1 not run · 1 off");
    expect(groupStatusItems([])).toEqual({ active: [], inactive: [] });
    expect(statusItemCounts([])).toBe("");
  });

  it("reopens a collapsed source when its state or a check worsens", () => {
    const collapsed = { expanded: false, state: "ok" as const };
    expect(sourceExpanded({ state: "ok", items: [] }, collapsed)).toBe(false);
    expect(sourceExpanded({ state: "warn", items: [] }, collapsed)).toBe(true);
    expect(sourceExpanded({ state: "fail", items: [] }, { expanded: false, state: "warn" })).toBe(
      true,
    );
    expect(
      sourceExpanded({ state: "ok", items: [{ name: "check", state: "fail" }] }, collapsed),
    ).toBe(true);
    expect(sourceExpanded({ state: "warn", items: [] }, { expanded: false, state: "warn" })).toBe(
      false,
    );
    expect(sourceExpanded({ state: "ok", items: [] }, { expanded: true, state: "fail" })).toBe(
      true,
    );
    expect(sourceExpanded({ state: "unknown", items: [] }, collapsed)).toBe(false);
    const collapsedBeforeAnyTransition = { expanded: false, state: "warn" as const, at: "" };
    expect(sourceExpanded({ state: "warn", items: [] }, collapsedBeforeAnyTransition)).toBe(false);
    expect(
      sourceExpanded(
        { state: "warn", items: [] },
        collapsedBeforeAnyTransition,
        "2026-11-18T01:05:00Z",
      ),
    ).toBe(true);
    const collapsedAtWarn = { expanded: false, state: "warn" as const, at: "2026-11-18T01:00:00Z" };
    expect(
      sourceExpanded({ state: "warn", items: [] }, collapsedAtWarn, "2026-11-18T00:59:00Z"),
    ).toBe(false);
    expect(
      sourceExpanded({ state: "warn", items: [] }, collapsedAtWarn, "2026-11-18T01:05:00Z"),
    ).toBe(true);
    expect(
      sourceExpanded({ state: "ok", items: [] }, collapsedAtWarn, "2026-11-18T01:05:00Z"),
    ).toBe(false);
  });

  it.each<{ state: StatusState; checks: StatusState[]; expanded: boolean }>([
    { state: "ok", checks: ["ok", "unknown"], expanded: false },
    { state: "unknown", checks: [], expanded: false },
    { state: "fail", checks: [], expanded: true },
    { state: "warn", checks: [], expanded: true },
    { state: "ok", checks: ["fail"], expanded: true },
    { state: "ok", checks: ["warn"], expanded: true },
  ])("defaults $state with $checks to expanded=$expanded", ({ state, checks, expanded }) => {
    expect(
      sourceDefaultExpanded({ state, items: checks.map((state) => ({ name: state, state })) }),
    ).toBe(expanded);
  });
});
