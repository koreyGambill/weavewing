import { describe, expect, it } from "vite-plus/test";
import {
  addSidebarThreadGroup,
  arrangeSidebarThreadGroups,
  changedSidebarThreadGroupNames,
  sidebarGroupToRecord,
  sidebarThreadGroupNameOf,
  deleteSidebarThreadGroup,
  discardNewSidebarThreadGroup,
  isUnnamedSidebarThreadGroup,
  localSidebarThreadGroups,
  EMPTY_SIDEBAR_THREAD_GROUPS,
  hasSidebarManualThreadOrder,
  moveSidebarThreadGroup,
  placeSidebarFolderThreads,
  placeSidebarThread,
  placeSidebarThreads,
  sidebarThreadGroupsForOrder,
  renameSidebarThreadGroup,
  setSidebarUngroupedHeader,
  resolveSidebarFolderDrop,
  resolveSidebarGroupDrop,
  resolveSidebarGroupHit,
  resolveSidebarShelfHit,
  stepSidebarFolderThread,
  stepSidebarThread,
  toggleSidebarThreadGroup,
  withServerSidebarGroups,
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
  ungroupedName: null,
  ungroupedIndex: 0,
  fixedUngroupedOrder: [],
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
    // In fixed order they join the end instead, so placed threads never shift down.
    const fixed = arrangeSidebarThreadGroups(
      state([["demo", ["c", "a"]]], ["d", "b"]),
      families("e", "a", "b", "c", "d", "f"),
      { hideEmptyGroups: false, threadOrder: "fixed" },
    );
    expect(heads(fixed.ungrouped)).toEqual(["d", "b", "e", "f"]);
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
  });

  it("places a thread dragged in from Pinned or Settled where it drops", () => {
    expect(
      resolveSidebarGroupDrop(arranged, "pinned", { kind: "thread", key: "a", after: false }),
    ).toEqual({ groupId: "demo", beforeKey: "a" });
    expect(resolveSidebarGroupDrop(arranged, "settled", { kind: "header", groupId: null })).toEqual(
      { groupId: null, beforeKey: "x" },
    );

    const fixed = arrangeSidebarThreadGroups(state([]), families("x", "y"), {
      hideEmptyGroups: false,
      threadOrder: "fixed",
    });
    const target = resolveSidebarGroupDrop(fixed, "pinned", {
      kind: "thread",
      key: "y",
      after: false,
    })!;
    expect(placeSidebarThread(state([]), fixed, "pinned", target).ungroupedOrder).toEqual([
      "x",
      "pinned",
      "y",
    ]);
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

    const fixed = arrangeSidebarThreadGroups(current, families("a", "y", "new"), {
      hideEmptyGroups: false,
      threadOrder: "fixed",
    });
    expect(
      placeSidebarThread(current, fixed, "a", { groupId: null, beforeKey: "y" }).ungroupedOrder,
    ).toEqual(["filtered-out", "a", "y", "new"]);
  });

  it("keeps the fixed Ungrouped order when a thread moves under recency order", () => {
    const stored = { ...state([], ["a", "b", "c"]), fixedUngroupedOrder: ["a", "b", "c"] };
    const arranged = arrangeSidebarThreadGroups(stored, families("c", "b", "a"), {
      hideEmptyGroups: false,
    });
    const next = placeSidebarThread(stored, arranged, "b", { groupId: null, beforeKey: "a" });
    expect(next.ungroupedOrder).toEqual(["b", "a", "c"]);
    const fixed = sidebarThreadGroupsForOrder(next, "fixed");
    expect(fixed.ungroupedOrder).toEqual(["a", "b", "c"]);
    expect(sidebarThreadGroupsForOrder(fixed, "fixed")).toEqual(next);
  });

  it("reorders fixed order without any groups, and leaves a group-free recency list alone", () => {
    expect(hasSidebarManualThreadOrder(EMPTY_SIDEBAR_THREAD_GROUPS, "recency")).toBe(false);
    expect(hasSidebarManualThreadOrder(state([["demo", []]]), "recency")).toBe(true);
    expect(hasSidebarManualThreadOrder(EMPTY_SIDEBAR_THREAD_GROUPS, "fixed")).toBe(true);

    const view = sidebarThreadGroupsForOrder(EMPTY_SIDEBAR_THREAD_GROUPS, "fixed");
    const arranged = arrangeSidebarThreadGroups(view, families("a", "b", "c"), {
      hideEmptyGroups: false,
      threadOrder: "fixed",
    });
    const stored = sidebarThreadGroupsForOrder(
      stepSidebarThread(view, arranged, "c", -1)!,
      "fixed",
    );
    expect(stored.fixedUngroupedOrder).toEqual(["a", "c", "b"]);
    expect(stored.ungroupedOrder).toEqual([]);
  });

  it("reorders under a filter without moving the threads it hides", () => {
    const current = state([], ["m", "hidden-1", "p", "hidden-2", "q"]);
    const arranged = arrangeSidebarThreadGroups(current, families("m", "p", "q"), {
      hideEmptyGroups: true,
    });
    const next = placeSidebarThread(current, arranged, "q", { groupId: null, beforeKey: "m" });
    expect(next.ungroupedOrder).toEqual(["q", "hidden-1", "m", "hidden-2", "p"]);
  });

  it("moves several threads as one block in the order given", () => {
    const current = state([
      ["demo", ["a", "b"]],
      ["other", ["c", "d"]],
    ]);
    const arranged = arrangeSidebarThreadGroups(current, families("a", "b", "c", "d", "u"), {
      hideEmptyGroups: false,
    });
    const intoGroup = placeSidebarThreads(current, arranged, ["a", "d", "u"], {
      groupId: "other",
      beforeKey: "c",
    });
    expect(intoGroup.groups.map((group) => group.threadKeys)).toEqual([
      ["b"],
      ["a", "d", "u", "c"],
    ]);

    const intoUngrouped = placeSidebarThreads(current, arranged, ["b", "c"], {
      groupId: null,
      beforeKey: "u",
    });
    expect(intoUngrouped.groups.map((group) => group.threadKeys)).toEqual([["a"], ["d"]]);
    expect(intoUngrouped.ungroupedOrder).toEqual(["b", "c", "u"]);
  });

  it("places a block before the next staying thread when it drops on one of its own", () => {
    const current = state([], ["a", "b", "c", "d"]);
    const arranged = arrangeSidebarThreadGroups(current, families("a", "b", "c", "d"), {
      hideEmptyGroups: false,
    });
    const next = placeSidebarThreads(current, arranged, ["a", "c"], {
      groupId: null,
      beforeKey: "c",
    });
    expect(next.ungroupedOrder).toEqual(["b", "a", "c", "d"]);
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

describe("project folder order", () => {
  // The flat list interleaved b1 between a1 and a2; a3 has never been arranged.
  const current = state([["g", ["a2"]]], ["a1", "b1", "a2"]);
  const folderA = families("a1", "a2", "a3+a3fork");
  const folders = {
    groups: [
      { group: { id: "A", name: "A", collapsed: false, threadKeys: [] }, families: folderA },
      { group: { id: "B", name: "B", collapsed: false, threadKeys: [] }, families: families("b1") },
    ],
    ungrouped: [],
    ungroupedAt: 0,
    freshAtEnd: true,
  };

  it("reorders within a folder in the slots its threads held, leaving groups and other folders", () => {
    const next = placeSidebarFolderThreads(current, folderA, ["a3"], "a1");
    expect(next.ungroupedOrder).toEqual(["a3", "b1", "a1", "a2"]);
    expect(next.groups).toBe(current.groups);
    expect(placeSidebarFolderThreads(current, folderA, ["a1"], null).ungroupedOrder).toEqual([
      "a2",
      "b1",
      "a3",
      "a1",
    ]);
  });

  it("drops only inside the dragged thread's own folder", () => {
    expect(resolveSidebarFolderDrop(folders, "a3", { kind: "header", groupId: "A" })).toEqual({
      groupId: "A",
      beforeKey: "a1",
    });
    expect(
      resolveSidebarFolderDrop(folders, "a1", { kind: "thread", key: "a3fork", after: false }),
    ).toEqual({
      groupId: "A",
      beforeKey: null,
    });
    expect(
      resolveSidebarFolderDrop(folders, "a1", { kind: "thread", key: "b1", after: false }),
    ).toBe(null);
    expect(resolveSidebarFolderDrop(folders, "a1", { kind: "header", groupId: "B" })).toBe(null);
    expect(
      resolveSidebarFolderDrop(folders, "x", { kind: "thread", key: "a1", after: false }),
    ).toBe(null);
  });

  it("steps a thread within its folder and stops at the folder's ends", () => {
    expect(stepSidebarFolderThread(current, folders, "a2", -1)?.ungroupedOrder).toEqual([
      "a2",
      "b1",
      "a1",
      "a3",
    ]);
    expect(stepSidebarFolderThread(current, folders, "a1", -1)).toBe(null);
    expect(stepSidebarFolderThread(current, folders, "a3", 1)).toBe(null);
    expect(stepSidebarFolderThread(current, folders, "a3fork", -1)).toBe(null);
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

  it("keeps Ungrouped above the groups until it is named, then moves it among them", () => {
    const current = state([
      ["one", ["a"]],
      ["two", ["b"]],
    ]);
    const options = { hideEmptyGroups: false };
    expect(arrangeSidebarThreadGroups(current, families("a", "b", "c"), options).ungroupedAt).toBe(
      0,
    );
    // A headerless Ungrouped has no place among the groups to move from.
    expect(moveSidebarThreadGroup(current, null, 1)).toBe(current);

    const named = renameSidebarThreadGroup(setSidebarUngroupedHeader(current, true), null, "Inbox");
    expect(named.ungroupedName).toBe("Inbox");
    const lowered = moveSidebarThreadGroup(moveSidebarThreadGroup(named, null, 1), null, 1);
    expect(lowered.ungroupedIndex).toBe(2);
    expect(moveSidebarThreadGroup(lowered, null, 1)).toBe(lowered);
    // A group moving down next to Ungrouped trades places with it.
    const swapped = moveSidebarThreadGroup(lowered, "two", 1);
    expect(swapped.groups.map((group) => group.id)).toEqual(["one", "two"]);
    expect(swapped.ungroupedIndex).toBe(1);
    // An empty group hidden by a filter does not count toward Ungrouped's place.
    expect(
      arrangeSidebarThreadGroups(lowered, families("b", "c"), { hideEmptyGroups: true })
        .ungroupedAt,
    ).toBe(1);
    // Deleting a group above Ungrouped keeps Ungrouped below the same groups.
    expect(deleteSidebarThreadGroup(lowered, "one").ungroupedIndex).toBe(1);

    const hidden = setSidebarUngroupedHeader(lowered, false);
    expect(hidden.ungroupedName).toBe(null);
    expect(arrangeSidebarThreadGroups(hidden, families("a", "b", "c"), options).ungroupedAt).toBe(
      0,
    );
  });
});

describe("server-recorded groups", () => {
  const local = state([
    ["A", ["a1", "moved"]],
    ["B", ["b1"]],
  ]);
  const recorded = new Map<string, string | null>([
    ["moved", "B"],
    ["b1", null],
    ["r1", "Remote"],
    ["r2", "Remote"],
    ["r3", "Second"],
    ["settled", "Hidden"],
  ]);
  const shownKeys = new Set(["a1", "moved", "b1", "r1", "r2", "r3"]);
  const view = withServerSidebarGroups(local, recorded, { shownKeys });
  let ids = 0;
  const makeId = () => `local-${++ids}`;

  it("places threads by their recorded group and shows unknown names only for shown threads", () => {
    expect(view.groups.map((group) => [group.name, group.threadKeys])).toEqual([
      ["A", ["a1"]],
      ["B", ["moved"]],
      ["Remote", ["r1", "r2"]],
      ["Second", ["r3"]],
    ]);
  });

  it("leaves a group being named with its local members", () => {
    const naming = addSidebarThreadGroup(local, {
      id: "new",
      name: "New group",
      threadKey: "moved",
    });
    const shown = withServerSidebarGroups(naming, recorded, { shownKeys, keepGroupId: "new" });
    expect(shown.groups.find((group) => group.id === "new")?.threadKeys).toEqual(["moved"]);
  });

  it("saves a remote-only group once edited or moved, keeping the derived groups above it", () => {
    expect(localSidebarThreadGroups(view, view, makeId).groups.map((g) => g.name)).toEqual([
      "A",
      "B",
    ]);
    const second = view.groups[3]!.id;
    for (const edited of [
      toggleSidebarThreadGroup(view, second),
      moveSidebarThreadGroup(view, second, -1),
    ]) {
      const saved = localSidebarThreadGroups(edited, view, makeId).groups;
      expect(saved.map((group) => group.name)).toEqual(edited.groups.map((group) => group.name));
      expect(saved.some((group) => group.id.startsWith("remote:"))).toBe(false);
    }
  });

  it("reports each thread whose group name an edit changes", () => {
    const renamed = renameSidebarThreadGroup(view, "A", "Alpha");
    expect(changedSidebarThreadGroupNames(view, renamed)).toEqual(
      new Map([["a1", { from: "A", to: "Alpha" }]]),
    );
    const deleted = deleteSidebarThreadGroup(view, view.groups[2]!.id);
    expect(changedSidebarThreadGroupNames(view, deleted)).toEqual(
      new Map([
        ["r1", { from: "Remote", to: null }],
        ["r2", { from: "Remote", to: null }],
      ]),
    );
  });

  it("reports a thread placed into Ungrouped from nowhere, and records only real changes", () => {
    // A settled thread's synced group is hidden, so the thread starts outside every container.
    const placed = { ...view, ungroupedOrder: ["settled"] };
    const change = changedSidebarThreadGroupNames(view, placed).get("settled");
    expect(change).toEqual({ from: null, to: null });
    expect(sidebarGroupToRecord(change!, "Hidden")).toBeNull();
    expect(sidebarGroupToRecord(change!, undefined)).toBeUndefined();
    expect(sidebarGroupToRecord({ from: null, to: "New group" }, "A")).toBeUndefined();
    expect(sidebarGroupToRecord({ from: "New group", to: null }, undefined)).toBeUndefined();
    expect(sidebarGroupToRecord({ from: "A", to: "B" }, "A")).toBe("B");
  });

  it("names the group a placed thread ends in, so a stale Ungrouped entry can't hide a change", () => {
    const stale = { ...view, ungroupedOrder: ["settled"] };
    const placed = placeSidebarThread(
      stale,
      arrangeSidebarThreadGroups(stale, families("settled"), { hideEmptyGroups: false }),
      "settled",
      { groupId: null, beforeKey: null },
    );
    // The before and after locations match, so the diff alone reports nothing for it.
    expect(changedSidebarThreadGroupNames(stale, placed).has("settled")).toBe(false);
    const to = sidebarThreadGroupNameOf(placed, "settled");
    expect(sidebarGroupToRecord({ from: null, to }, "Hidden")).toBeNull();
    expect(sidebarThreadGroupNameOf(view, "moved")).toBe("B");
  });

  it("refuses a name another group has, or one too long for the server", () => {
    expect(renameSidebarThreadGroup(view, "A", "B")).toBe(view);
    expect(renameSidebarThreadGroup(view, "A", "x".repeat(65))).toBe(view);
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

describe("discardNewSidebarThreadGroup", () => {
  it("removes a group that was never named and puts its thread back where it was", () => {
    const before = state([["old", ["a", "b"]]], ["c"]);
    const created = addSidebarThreadGroup(before, { id: "g", name: "New group", threadKey: "b" });
    expect(discardNewSidebarThreadGroup(created, before, "g")).toEqual(before);
  });

  it("returns a thread to its place in Ungrouped's order", () => {
    const before = state([], ["x", "y", "z"]);
    const created = addSidebarThreadGroup(before, { id: "g", name: "New group", threadKey: "y" });
    expect(discardNewSidebarThreadGroup(created, before, "g").ungroupedOrder).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("keeps changes made elsewhere while the group was being named", () => {
    const before = state([["old", ["a"]]]);
    const created = addSidebarThreadGroup(before, { id: "g", name: "New group" });
    const meanwhile = toggleSidebarThreadGroup(created, "old");
    const discarded = discardNewSidebarThreadGroup(meanwhile, before, "g");
    expect(discarded.groups).toEqual([
      { id: "old", name: "old", collapsed: true, threadKeys: ["a"] },
    ]);
  });
});

describe("isUnnamedSidebarThreadGroup", () => {
  it.each([
    ["", true],
    ["   ", true],
    ["New group", true],
    [" New group ", true],
    ["Demo", false],
  ])("%j is unnamed: %s", (name, unnamed) => {
    expect(isUnnamedSidebarThreadGroup(name)).toBe(unnamed);
  });
});
