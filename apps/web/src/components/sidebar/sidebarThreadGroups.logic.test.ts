import { describe, expect, it } from "vite-plus/test";
import {
  addSidebarThreadGroup,
  arrangeSidebarThreadGroups,
  deleteSidebarThreadGroup,
  EMPTY_SIDEBAR_THREAD_GROUPS,
  moveSidebarThreadGroup,
  placeSidebarThread,
  resolveSidebarGroupDrop,
  resolveSidebarGroupHit,
  resolveSidebarShelfHit,
  stepSidebarThread,
  type SidebarThreadGroups,
} from "./sidebarThreadGroups.logic";

const state = (
  groups: Array<[id: string, keys: string[], collapsed?: boolean]>,
  ungroupedOrder: string[] = [],
): SidebarThreadGroups => ({
  groups: groups.map(([id, threadKeys, collapsed = false]) => ({
    id,
    name: id,
    collapsed,
    threadKeys,
  })),
  ungroupedOrder,
  ungroupedCollapsed: false,
});

const families = (...keys: string[]) => keys.map((key) => key.split("+"));
const heads = (list: ReadonlyArray<readonly string[]>) => list.map((family) => family[0]);

describe("arrangeSidebarThreadGroups", () => {
  it("keeps group order, leaves unlisted threads at the top of Ungrouped in input order", () => {
    const arranged = arrangeSidebarThreadGroups(
      state([["demo", ["c", "a"]]], ["d", "b"]),
      families("e", "a", "b", "c", "d", "f"),
      { hideEmptyGroups: false },
    );
    expect(arranged.groups.map((group) => heads(group.families))).toEqual([["c", "a"]]);
    // e and f are new to the manual order, so they sit above it in recency order.
    expect(heads(arranged.ungrouped)).toEqual(["e", "f", "d", "b"]);
  });

  it("keeps a fork with its parent wherever the parent is placed", () => {
    const arranged = arrangeSidebarThreadGroups(
      state([["demo", ["p"]]]),
      families("x", "p+child"),
      { hideEmptyGroups: false },
    );
    expect(arranged.groups[0]!.families).toEqual([["p", "child"]]);
    expect(arranged.ungrouped).toEqual([["x"]]);
  });

  it("hides empty groups only when asked, as under a project filter", () => {
    const groups = state([
      ["empty", []],
      ["hidden-members", ["settled"]],
      ["full", ["a"]],
    ]);
    expect(
      arrangeSidebarThreadGroups(groups, families("a"), { hideEmptyGroups: false }).groups.map(
        (group) => group.group.id,
      ),
    ).toEqual(["empty", "hidden-members", "full"]);
    expect(
      arrangeSidebarThreadGroups(groups, families("a"), { hideEmptyGroups: true }).groups.map(
        (group) => group.group.id,
      ),
    ).toEqual(["full"]);
    // A group being created or renamed stays on screen so its name field does too.
    expect(
      arrangeSidebarThreadGroups(groups, families("a"), {
        hideEmptyGroups: true,
        keepGroupId: "empty",
      }).groups.map((group) => group.group.id),
    ).toEqual(["empty", "full"]);
  });
});

describe("resolveSidebarGroupDrop", () => {
  const arranged = arrangeSidebarThreadGroups(
    state([
      ["demo", ["a", "b"]],
      ["empty", []],
    ]),
    families("x", "y+y1", "a", "b"),
    { hideEmptyGroups: false },
  );

  it("drops above or below a row in its container", () => {
    expect(
      resolveSidebarGroupDrop(arranged, "x", { kind: "thread", key: "b", after: false }),
    ).toEqual({ groupId: "demo", beforeKey: "b" });
    expect(
      resolveSidebarGroupDrop(arranged, "x", { kind: "thread", key: "b", after: true }),
    ).toEqual({ groupId: "demo", beforeKey: null });
  });

  it("treats a fork row as the end of its family", () => {
    expect(
      resolveSidebarGroupDrop(arranged, "a", { kind: "thread", key: "y1", after: false }),
    ).toEqual({ groupId: null, beforeKey: null });
  });

  it("drops onto a header at the top of that group", () => {
    expect(resolveSidebarGroupDrop(arranged, "x", { kind: "header", groupId: "demo" })).toEqual({
      groupId: "demo",
      beforeKey: "a",
    });
    expect(resolveSidebarGroupDrop(arranged, "x", { kind: "header", groupId: "empty" })).toEqual({
      groupId: "empty",
      beforeKey: null,
    });
  });

  it("returns null when the thread would land where it already is", () => {
    expect(resolveSidebarGroupDrop(arranged, "a", { kind: "thread", key: "a", after: true })).toBe(
      null,
    );
    expect(resolveSidebarGroupDrop(arranged, "a", { kind: "thread", key: "b", after: false })).toBe(
      null,
    );
    expect(resolveSidebarGroupDrop(arranged, "a", { kind: "header", groupId: "demo" })).toBe(null);
  });

  it("ignores rows outside the grouped area", () => {
    expect(
      resolveSidebarGroupDrop(arranged, "x", { kind: "thread", key: "pinned", after: false }),
    ).toBe(null);
    expect(
      resolveSidebarGroupDrop(arranged, "pinned", { kind: "thread", key: "a", after: false }),
    ).toBe(null);
  });
});

describe("placeSidebarThread", () => {
  it("moves a thread between groups and keeps hidden members in place", () => {
    const current = state([
      ["demo", ["a", "settled", "b"]],
      ["other", ["c"]],
    ]);
    const arranged = arrangeSidebarThreadGroups(current, families("a", "b", "c"), {
      hideEmptyGroups: false,
    });
    const next = placeSidebarThread(current, arranged, "c", { groupId: "demo", beforeKey: "b" });
    expect(next.groups.map((group) => group.threadKeys)).toEqual([["a", "settled", "c", "b"], []]);
  });

  it("writes the shown Ungrouped order and keeps hidden entries in their slots", () => {
    const current = state([["demo", ["a"]]], ["filtered-out", "y"]);
    const arranged = arrangeSidebarThreadGroups(current, families("new", "a", "y"), {
      hideEmptyGroups: false,
    });
    const next = placeSidebarThread(current, arranged, "a", { groupId: null, beforeKey: "y" });
    expect(next.groups[0]!.threadKeys).toEqual([]);
    expect(next.ungroupedOrder).toEqual(["new", "filtered-out", "a", "y"]);
  });

  it("reorders under a filter without moving the threads it hides", () => {
    const current = state([], ["m", "hidden-1", "p", "hidden-2", "q"]);
    const arranged = arrangeSidebarThreadGroups(current, families("m", "p", "q"), {
      hideEmptyGroups: true,
    });
    const next = placeSidebarThread(current, arranged, "q", { groupId: null, beforeKey: "m" });
    expect(next.ungroupedOrder).toEqual(["q", "hidden-1", "m", "hidden-2", "p"]);
  });

  it("returns the state unchanged for a group that no longer exists", () => {
    const current = state([["demo", []]]);
    const arranged = arrangeSidebarThreadGroups(current, families("a"), {
      hideEmptyGroups: false,
    });
    expect(placeSidebarThread(current, arranged, "a", { groupId: "gone", beforeKey: null })).toBe(
      current,
    );
  });
});

describe("stepSidebarThread", () => {
  const current = state([["demo", ["a", "b", "c"]]]);
  const arranged = arrangeSidebarThreadGroups(current, families("a", "b", "c", "u"), {
    hideEmptyGroups: false,
  });

  it("moves a thread one place within its container", () => {
    expect(stepSidebarThread(current, arranged, "b", -1)?.groups[0]!.threadKeys).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(stepSidebarThread(current, arranged, "b", 1)?.groups[0]!.threadKeys).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("stops at the ends of its container", () => {
    expect(stepSidebarThread(current, arranged, "a", -1)).toBe(null);
    expect(stepSidebarThread(current, arranged, "c", 1)).toBe(null);
    expect(stepSidebarThread(current, arranged, "u", 1)).toBe(null);
  });
});

describe("group edits", () => {
  it("adds a group with its first thread and takes the thread out of Ungrouped's order", () => {
    const next = addSidebarThreadGroup(
      { ...EMPTY_SIDEBAR_THREAD_GROUPS, ungroupedOrder: ["a", "b"] },
      { id: "g", name: "Demo", threadKey: "a" },
    );
    expect(next.groups).toEqual([{ id: "g", name: "Demo", collapsed: false, threadKeys: ["a"] }]);
    expect(next.ungroupedOrder).toEqual(["b"]);
  });

  it("moves an existing member out of its old group into the new one", () => {
    const next = addSidebarThreadGroup(state([["old", ["a", "b"]]]), {
      id: "g",
      name: "Demo",
      threadKey: "a",
    });
    expect(next.groups.map((group) => [group.id, group.threadKeys])).toEqual([
      ["old", ["b"]],
      ["g", ["a"]],
    ]);
  });

  it("deleting a group keeps its threads, which return to Ungrouped", () => {
    const current = state([["demo", ["a"]]], ["b"]);
    const next = deleteSidebarThreadGroup(current, "demo");
    expect(next.groups).toEqual([]);
    const arranged = arrangeSidebarThreadGroups(next, families("a", "b"), {
      hideEmptyGroups: false,
    });
    expect(heads(arranged.ungrouped)).toEqual(["a", "b"]);
  });

  it("reorders groups one step and stops at the ends", () => {
    const current = state([
      ["one", []],
      ["two", []],
    ]);
    expect(moveSidebarThreadGroup(current, "two", -1).groups.map((group) => group.id)).toEqual([
      "two",
      "one",
    ]);
    expect(moveSidebarThreadGroup(current, "one", -1)).toBe(current);
  });
});

describe("resolveSidebarGroupHit", () => {
  const rows = [
    { kind: "header" as const, groupId: "demo", top: 0, bottom: 32 },
    { kind: "thread" as const, key: "a", top: 33, bottom: 113 },
    { kind: "end" as const, groupId: "demo", top: 114, bottom: 114 },
    { kind: "header" as const, groupId: null, top: 114, bottom: 146 },
    { kind: "thread" as const, key: "b", top: 147, bottom: 227 },
    { kind: "end" as const, groupId: null, top: 228, bottom: 228 },
  ];

  it("hits a header or the near half of a row", () => {
    expect(resolveSidebarGroupHit(rows, 10)).toEqual({ kind: "header", groupId: "demo" });
    expect(resolveSidebarGroupHit(rows, 40)).toEqual({ kind: "thread", key: "a", after: false });
    expect(resolveSidebarGroupHit(rows, 100)).toEqual({ kind: "thread", key: "a", after: true });
    expect(resolveSidebarGroupHit(rows, 113.5)).toEqual({ kind: "thread", key: "a", after: true });
  });

  it("misses above the first header and well below the last group", () => {
    expect(resolveSidebarGroupHit(rows, -5)).toBe(null);
    expect(resolveSidebarGroupHit(rows, 240)).toBe(null);
  });
});

describe("resolveSidebarShelfHit", () => {
  const layout = {
    listTop: 100,
    firstGroupTop: 300,
    pinnedRows: [{ key: "pinned-a", top: 110, bottom: 190 }],
    pinnedHeaderId: "pinned-header",
    settledTop: 900,
    settledHeaderId: "settled-header",
  };

  it("pins above the first group, at a pinned row or else at the top", () => {
    expect(resolveSidebarShelfHit({ ...layout, y: 150 })).toEqual({
      section: "pinned",
      overId: "pinned-a",
    });
    expect(resolveSidebarShelfHit({ ...layout, y: 250 })).toEqual({
      section: "pinned",
      overId: "pinned-header",
    });
  });

  it("settles from just above the Settled header down, and misses in between", () => {
    expect(resolveSidebarShelfHit({ ...layout, y: 898 })).toEqual({
      section: "settled",
      overId: "settled-header",
    });
    expect(resolveSidebarShelfHit({ ...layout, y: 600 })).toBe(null);
    expect(resolveSidebarShelfHit({ ...layout, y: 40 })).toBe(null);
  });
});
