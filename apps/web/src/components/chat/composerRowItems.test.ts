import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_ROW_PRIORITY,
  type ComposerRowItemWidth,
  resolveComposerRowHiddenIds,
  summarizeComposerRowAgents,
} from "./composerRowItems";

// On-screen order: computer, location, branch, diff, agents. Gaps of 4 and a 24 px menu.
const items: ReadonlyArray<ComposerRowItemWidth> = [
  { id: "computer", priority: COMPOSER_ROW_PRIORITY.computer, natural: 100, minimum: 100 },
  { id: "location", priority: null, natural: 200, minimum: 90 },
  { id: "branch", priority: COMPOSER_ROW_PRIORITY.branch, natural: 150, minimum: 70 },
  { id: "diff", priority: null, natural: 60, minimum: 60 },
  { id: "agents", priority: null, natural: 70, minimum: 70 },
];
// Every item at its minimum, each followed by a gap, then the menu.
const minimumRowWidth = 100 + 90 + 70 + 60 + 70 + 5 * 4 + 24;

function hiddenAt(availableWidth: number, previousHiddenIds: ReadonlyArray<string> = []) {
  return resolveComposerRowHiddenIds({
    items,
    availableWidth,
    gap: 4,
    menuWidth: 24,
    previousHiddenIds,
  });
}

describe("resolveComposerRowHiddenIds", () => {
  it("keeps every item while shortened labels still fit", () => {
    expect(hiddenAt(minimumRowWidth)).toEqual([]);
  });

  it("moves computer to the menu first, then branch", () => {
    expect(hiddenAt(minimumRowWidth - 1)).toEqual(["computer"]);
    expect(hiddenAt(minimumRowWidth - 104)).toEqual(["computer"]);
    expect(hiddenAt(minimumRowWidth - 105)).toEqual(["computer", "branch"]);
  });

  it("never moves location, diff or agents, however narrow the row", () => {
    expect(hiddenAt(50)).toEqual(["computer", "branch"]);
  });

  it("moves a registered item with a lower priority before computer", () => {
    const withTools = [
      ...items,
      { id: "tools", priority: COMPOSER_ROW_PRIORITY.tools, natural: 50, minimum: 50 },
    ];
    expect(
      resolveComposerRowHiddenIds({
        items: withTools,
        availableWidth: minimumRowWidth,
        gap: 4,
        menuWidth: 24,
        previousHiddenIds: [],
      }),
    ).toEqual(["tools"]);
  });

  it("needs extra room before bringing an item back from the menu", () => {
    expect(hiddenAt(minimumRowWidth, ["computer"])).toEqual(["computer"]);
    expect(hiddenAt(minimumRowWidth + 15, ["computer"])).toEqual(["computer"]);
    expect(hiddenAt(minimumRowWidth + 16, ["computer"])).toEqual([]);
  });

  it("ignores items that are not in the row", () => {
    expect(
      resolveComposerRowHiddenIds({
        items: items.filter((item) => item.id !== "computer"),
        availableWidth: minimumRowWidth - 1,
        gap: 4,
        menuWidth: 24,
        previousHiddenIds: ["computer"],
      }),
    ).toEqual([]);
  });
});

describe("summarizeComposerRowAgents", () => {
  it("is null for a thread that never delegated", () => {
    expect(summarizeComposerRowAgents(undefined)).toBeNull();
    expect(summarizeComposerRowAgents([])).toBeNull();
  });

  it("leads with the working count while any child works", () => {
    expect(
      summarizeComposerRowAgents([
        { status: "running" },
        { status: "pending" },
        { status: "failed" },
        { status: "completed" },
      ]),
    ).toMatchObject({
      tone: "working",
      label: "2 working",
      count: 2,
      description: "Agents: 2 working, 1 failed, 1 done",
    });
  });

  it("names a failure once nothing works", () => {
    expect(
      summarizeComposerRowAgents([{ status: "failed" }, { status: "completed" }]),
    ).toMatchObject({ tone: "failed", label: "1 failed", count: 1 });
  });

  it("counts completed children as done", () => {
    expect(
      summarizeComposerRowAgents([{ status: "completed" }, { status: "completed" }]),
    ).toMatchObject({ tone: "idle", label: "2 done", description: "Agents: 2 done" });
  });

  it("calls children that ended without completing past, not done", () => {
    expect(summarizeComposerRowAgents([{ status: "cancelled" }])).toMatchObject({
      tone: "idle",
      done: 0,
      past: 1,
      label: "1 past",
      description: "Agents: 1 past",
    });
    expect(
      summarizeComposerRowAgents([
        { status: "completed" },
        { status: "interrupted" },
        { status: "cancelled" },
      ]),
    ).toMatchObject({ label: "3 past", description: "Agents: 1 done, 2 past" });
  });
});
