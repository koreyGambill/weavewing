import { describe, expect, it } from "vite-plus/test";
import type { StatusItem, StatusState } from "@t3tools/contracts";

import { groupStatusItems, sourceDefaultExpanded, statusItemCounts } from "./statusSources.logic";

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
