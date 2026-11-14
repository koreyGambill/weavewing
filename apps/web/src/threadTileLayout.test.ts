import { describe, expect, it } from "vite-plus/test";
import {
  applyTileAction,
  CONVERSATION_TAB_ID,
  getTileGroups,
  newTabId,
  parseTileLayout,
  resizeFloatingTile,
  syncTileLayout,
} from "./threadTileLayout";

describe("thread tile layout", () => {
  it("floats, bounds, persists and docks groups without changing tab ownership", () => {
    const initial = syncTileLayout(undefined, [], ["a", "b"], "a", true);
    const floating = applyTileAction(initial, {
      type: "float-group",
      groupId: "panels-group",
      rect: { x: 0.8, y: -0.2, width: 0.6, height: 0.5 },
    });
    expect(getTileGroups(floating)[1]?.floating).toEqual({ x: 0.4, y: 0, width: 0.6, height: 0.5 });
    expect(getTileGroups(floating).flatMap((group) => group.tabs)).toEqual([
      CONVERSATION_TAB_ID,
      "a",
      "b",
    ]);
    expect(parseTileLayout(JSON.parse(JSON.stringify(floating)))).toEqual(floating);
    const synced = syncTileLayout(floating, ["a", "b"], ["a", "b", "c"], "c", true);
    expect(getTileGroups(synced)[1]?.floating).toEqual(getTileGroups(floating)[1]?.floating);
    const docked = applyTileAction(floating, { type: "restore-group", groupId: "panels-group" });
    expect(getTileGroups(docked)).toEqual([
      getTileGroups(initial)[0],
      { ...getTileGroups(initial)[1], lastFloating: getTileGroups(floating)[1]?.floating },
    ]);
    expect(parseTileLayout(JSON.parse(JSON.stringify(docked)))).toEqual(docked);
    const moved = applyTileAction(floating, {
      type: "dock-group",
      groupId: "panels-group",
      targetGroupId: "conversation-group",
      axis: "vertical",
      side: "after",
      splitId: "dock-split",
    });
    expect(getTileGroups(moved)[1]?.floating).toBeUndefined();
    const merged = applyTileAction(floating, {
      type: "merge-groups",
      groupId: "panels-group",
      targetGroupId: "conversation-group",
    });
    expect(getTileGroups(merged).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID, "a", "b"],
    ]);
  });

  it("resizes floating tiles from any edge inside the workspace and keeps one tile docked", () => {
    const rect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
    const resize = (...args: Parameters<typeof resizeFloatingTile>) =>
      Object.values(resizeFloatingTile(...args)).map((value) => Math.round(value * 100) / 100);
    expect(resize(rect, { left: true, top: true }, { x: -0.1, y: -0.5 })).toEqual([
      0.1, 0, 0.5, 0.6,
    ]);
    expect(resize(rect, { right: true }, { x: 1, y: 1 })).toEqual([0.2, 0.2, 0.8, 0.4]);
    expect(resize(rect, { left: true, bottom: true }, { x: 0.5, y: -0.5 })).toEqual([
      0.4, 0.2, 0.2, 0.2,
    ]);
    const single = syncTileLayout(undefined, [], [], null, false);
    expect(
      applyTileAction(single, { type: "float-group", groupId: "conversation-group", rect }),
    ).toBe(single);
    const chatFloating = applyTileAction(syncTileLayout(undefined, [], ["a"], "a", true), {
      type: "float-group",
      groupId: "conversation-group",
      rect,
    });
    expect(
      applyTileAction(chatFloating, { type: "float-group", groupId: "panels-group", rect }),
    ).toBe(chatFloating);
    const maximized = applyTileAction(chatFloating, {
      type: "maximize",
      groupId: "panels-group",
    });
    const moved = applyTileAction(maximized, {
      type: "float-group",
      groupId: "conversation-group",
      rect: { ...rect, x: 0.3 },
    });
    expect([moved.maximizedGroupId, moved.focusedGroupId]).toEqual([
      "panels-group",
      "conversation-group",
    ]);
    expect(
      applyTileAction(maximized, { type: "restore-group", groupId: "conversation-group" })
        .maximizedGroupId,
    ).toBeNull();
  });

  it("treats chat as an ordinary area that closes, reopens and leaves a chooser when last", () => {
    const initial = syncTileLayout(undefined, [], ["files"], "files", true);
    const noChat = applyTileAction(initial, { type: "close-tab", tabId: CONVERSATION_TAB_ID });
    expect(getTileGroups(noChat).map((group) => group.tabs)).toEqual([["files"]]);
    const stillNoChat = syncTileLayout(noChat, ["files"], ["files", "notes"], "notes", true);
    expect(getTileGroups(stillNoChat).map((group) => group.tabs)).toEqual([["files", "notes"]]);
    const chooser = syncTileLayout(noChat, ["files"], [], null, false);
    const chooserTab = newTabId(chooser.focusedGroupId);
    expect(getTileGroups(chooser)).toMatchObject([{ tabs: [chooserTab], activeTabId: chooserTab }]);
    expect(applyTileAction(chooser, { type: "close-tab", tabId: chooserTab })).toBe(chooser);
    expect(applyTileAction(chooser, { type: "close-group", groupId: chooser.focusedGroupId })).toBe(
      chooser,
    );
    const reopened = applyTileAction(chooser, {
      type: "move",
      tabId: CONVERSATION_TAB_ID,
      targetGroupId: chooser.focusedGroupId,
    });
    expect(getTileGroups(reopened)).toMatchObject([
      { tabs: [CONVERSATION_TAB_ID], activeTabId: CONVERSATION_TAB_ID },
    ]);
    const lastChat = applyTileAction(reopened, { type: "close-tab", tabId: CONVERSATION_TAB_ID });
    expect(getTileGroups(lastChat)).toMatchObject([{ tabs: [newTabId(lastChat.focusedGroupId)] }]);
    const shared = applyTileAction(initial, {
      type: "move",
      tabId: "files",
      targetGroupId: "conversation-group",
      index: 0,
    });
    expect(
      getTileGroups(applyTileAction(shared, { type: "close-tab", tabId: CONVERSATION_TAB_ID })),
    ).toMatchObject([{ tabs: ["files"], activeTabId: "files" }]);
    const closedTile = applyTileAction(initial, { type: "close-group", groupId: "panels-group" });
    expect(getTileGroups(closedTile).map((group) => group.id)).toEqual(["conversation-group"]);
    const lastTile = applyTileAction(closedTile, {
      type: "close-group",
      groupId: "conversation-group",
    });
    expect(getTileGroups(lastTile)).toMatchObject([
      { id: "conversation-group", tabs: [newTabId("conversation-group")] },
    ]);
    expect(parseTileLayout(JSON.parse(JSON.stringify(lastTile)))).toEqual(lastTile);
    // Layouts persisted before empty tiles held a New tab still decode.
    expect(
      getTileGroups(
        parseTileLayout({
          root: { kind: "group", id: "old", tabs: [], activeTabId: "" },
          focusedGroupId: "old",
        })!,
      ),
    ).toMatchObject([{ tabs: [newTabId("old")], activeTabId: newTabId("old") }]);
  });

  it("replaces a new tab in place with the area chosen for it, and closes it on its own", () => {
    let layout = syncTileLayout(undefined, [], ["files", "notes"], "files", true);
    layout = applyTileAction(layout, {
      type: "new-tab",
      groupId: "panels-group",
      tabId: newTabId("a"),
    });
    expect(getTileGroups(layout)[1]).toMatchObject({
      tabs: ["files", "notes", newTabId("a")],
      activeTabId: newTabId("a"),
    });
    expect(applyTileAction(layout, { type: "new-tab", groupId: "panels-group", tabId: "x" })).toBe(
      layout,
    );
    layout = applyTileAction(layout, {
      type: "move",
      tabId: "files",
      targetGroupId: "panels-group",
      index: 0,
    });
    expect(getTileGroups(layout)[1]?.activeTabId).toBe("files");
    const persisted = parseTileLayout(JSON.parse(JSON.stringify(layout)))!;
    const fresh = applyTileAction(persisted, {
      type: "new-tab",
      groupId: "panels-group",
      tabId: newTabId("b"),
    });
    expect(syncTileLayout(fresh, ["files", "notes"], ["files", "notes"], null, false)).toEqual(
      fresh,
    );
    const created = syncTileLayout(
      fresh,
      ["files", "notes"],
      ["files", "notes", "diff"],
      "diff",
      true,
    );
    expect(getTileGroups(created)[1]).toMatchObject({
      tabs: ["notes", "files", "diff"],
      activeTabId: "diff",
    });
    const existing = syncTileLayout(
      applyTileAction(fresh, {
        type: "new-tab",
        groupId: "conversation-group",
        tabId: newTabId("c"),
      }),
      ["files", "notes"],
      ["files", "notes"],
      "notes",
      true,
    );
    expect(getTileGroups(existing).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID, "notes"],
      ["files", newTabId("b")],
    ]);
    const chat = applyTileAction(
      applyTileAction(fresh, { type: "close-tab", tabId: CONVERSATION_TAB_ID }),
      { type: "move", tabId: CONVERSATION_TAB_ID, targetGroupId: "panels-group" },
    );
    expect(getTileGroups(chat)[0]?.tabs).toEqual(["notes", "files", CONVERSATION_TAB_ID]);
    const byCode = syncTileLayout(
      fresh,
      ["files", "notes"],
      ["files", "notes", "x"],
      "x",
      true,
      false,
    );
    expect(getTileGroups(byCode).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID, "x"],
      ["notes", "files", newTabId("b")],
    ]);
    const choosing = applyTileAction(fresh, {
      type: "new-tab",
      groupId: "conversation-group",
      tabId: newTabId("c"),
    });
    const revealed = syncTileLayout(
      choosing,
      ["files", "notes"],
      ["files", "notes"],
      "notes",
      true,
      false,
    );
    expect(getTileGroups(revealed).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID, newTabId("c")],
      ["notes", "files", newTabId("b")],
    ]);
    const lone = applyTileAction(syncTileLayout(undefined, [], [], null, false), {
      type: "new-tab",
      groupId: "conversation-group",
      tabId: newTabId("d"),
    });
    const closed = applyTileAction(lone, { type: "close-tab", tabId: newTabId("d") });
    expect(getTileGroups(closed)[0]?.activeTabId).toBe(CONVERSATION_TAB_ID);
  });

  it("moves tabs and splits conversation without losing or duplicating any tab", () => {
    let layout = syncTileLayout(undefined, [], ["a", "b"], "b", true);
    layout = applyTileAction(layout, {
      type: "move",
      tabId: "a",
      targetGroupId: "conversation-group",
      index: 0,
    });
    expect(getTileGroups(layout).map((group) => group.tabs)).toEqual([
      ["a", CONVERSATION_TAB_ID],
      ["b"],
    ]);
    layout = applyTileAction(layout, { type: "maximize", groupId: "conversation-group" });
    layout = applyTileAction(layout, {
      type: "split",
      tabId: CONVERSATION_TAB_ID,
      targetGroupId: "panels-group",
      axis: "vertical",
      side: "after",
      groupId: "chat-below",
      splitId: "vertical",
    });
    expect(getTileGroups(layout).map((group) => group.tabs)).toEqual([
      ["a"],
      ["b"],
      [CONVERSATION_TAB_ID],
    ]);
    expect(layout.focusedGroupId).toBe("chat-below");
    expect(layout.maximizedGroupId).toBeNull();
    layout = applyTileAction(layout, { type: "move", tabId: "b", targetGroupId: "chat-below" });
    expect(getTileGroups(layout).map((group) => group.tabs)).toEqual([
      ["a"],
      [CONVERSATION_TAB_ID, "b"],
    ]);
    expect(getTileGroups(layout).every((group) => group.tabs.length > 0)).toBe(true);
  });

  it("swaps whole groups with their identity and active tabs intact", () => {
    const initial = syncTileLayout(undefined, [], ["a", "b"], "b", true);
    const maximized = applyTileAction(initial, { type: "maximize", groupId: "panels-group" });
    const swapped = applyTileAction(maximized, {
      type: "swap-groups",
      firstGroupId: "panels-group",
      secondGroupId: "conversation-group",
    });
    expect(getTileGroups(swapped)).toEqual(getTileGroups(initial).toReversed());
    expect(swapped.focusedGroupId).toBe("panels-group");
    expect(swapped.maximizedGroupId).toBeNull();
    expect(parseTileLayout(JSON.parse(JSON.stringify(swapped)))).toEqual(swapped);
    const merged = applyTileAction(maximized, {
      type: "merge-groups",
      groupId: "panels-group",
      targetGroupId: "conversation-group",
    });
    expect(getTileGroups(merged)).toEqual([
      {
        ...getTileGroups(initial)[0],
        tabs: [CONVERSATION_TAB_ID, "a", "b"],
        activeTabId: "b",
      },
    ]);
    expect(merged.focusedGroupId).toBe("conversation-group");
    expect(merged.maximizedGroupId).toBeNull();
    expect(parseTileLayout(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
    for (const [groupId, targetGroupId] of [
      ["panels-group", "panels-group"],
      ["missing", "conversation-group"],
      ["panels-group", "missing"],
    ]) {
      expect(
        applyTileAction(maximized, {
          type: "merge-groups",
          groupId: groupId!,
          targetGroupId: targetGroupId!,
        }),
      ).toBe(maximized);
    }
    for (const [firstGroupId, secondGroupId] of [
      ["panels-group", "panels-group"],
      ["missing", "conversation-group"],
      ["panels-group", "initial-split"],
    ]) {
      expect(
        applyTileAction(maximized, {
          type: "swap-groups",
          firstGroupId: firstGroupId!,
          secondGroupId: secondGroupId!,
        }),
      ).toBe(maximized);
    }
  });

  it("docks whole groups across nested branches and collapses their old split", () => {
    let initial = syncTileLayout(undefined, [], ["a", "b", "c"], "b", true);
    initial = applyTileAction(initial, {
      type: "split",
      tabId: "c",
      targetGroupId: "panels-group",
      axis: "vertical",
      side: "after",
      groupId: "terminal-group",
      splitId: "nested-split",
    });
    const groups = getTileGroups(initial);
    expect(groups.map((group) => group.colorIndex)).toEqual([0, 1, 2]);
    for (const [groupId, targetGroupId, side, expected] of [
      ["panels-group", "conversation-group", "before", [groups[1], groups[0], groups[2]]],
      ["conversation-group", "panels-group", "after", [groups[1], groups[0], groups[2]]],
      ["panels-group", "terminal-group", "after", [groups[0], groups[2], groups[1]]],
    ] as const) {
      const docked = applyTileAction(initial, {
        type: "dock-group",
        groupId,
        targetGroupId,
        axis: "horizontal",
        side,
        splitId: "docked-split",
      });
      expect(getTileGroups(docked)).toEqual(expected);
      expect(docked.focusedGroupId).toBe(groupId);
      expect(docked.maximizedGroupId).toBeNull();
      expect(parseTileLayout(JSON.parse(JSON.stringify(docked)))).toEqual(docked);
      expect(docked.root).toMatchObject({
        kind: "split",
        id: groupId === "conversation-group" ? "nested-split" : "initial-split",
      });
    }
    for (const [groupId, targetGroupId, splitId] of [
      ["panels-group", "panels-group", "new-split"],
      ["missing", "conversation-group", "new-split"],
      ["panels-group", "missing", "new-split"],
      ["panels-group", "conversation-group", "nested-split"],
      ["panels-group", "conversation-group", "terminal-group"],
    ]) {
      expect(
        applyTileAction(initial, {
          type: "dock-group",
          groupId: groupId!,
          targetGroupId: targetGroupId!,
          axis: "vertical",
          side: "before",
          splitId: splitId!,
        }),
      ).toBe(initial);
    }
  });

  it("keeps new groups empty until an area is chosen and collapses them after that area closes", () => {
    const initial = syncTileLayout(undefined, [], [], null, false);
    const empty = applyTileAction(initial, {
      type: "new-group",
      targetGroupId: "conversation-group",
      axis: "horizontal",
      side: "after",
      groupId: "chooser-group",
      splitId: "chooser-split",
    });
    expect(getTileGroups(empty)).toEqual([
      ...getTileGroups(initial),
      {
        kind: "group",
        id: "chooser-group",
        tabs: [newTabId("chooser-group")],
        activeTabId: newTabId("chooser-group"),
        colorIndex: 1,
      },
    ]);
    expect(empty.focusedGroupId).toBe("chooser-group");
    expect(applyTileAction(empty, { type: "close-group", groupId: "chooser-group" })).toEqual(
      initial,
    );
    expect(
      getTileGroups(applyTileAction(empty, { type: "close-group", groupId: "conversation-group" })),
    ).toEqual([getTileGroups(empty)[1]]);
    expect(applyTileAction(empty, { type: "close-group", groupId: "missing" })).toBe(empty);
    const loneEmpty = parseTileLayout({
      root: { kind: "group", id: "empty", tabs: [], activeTabId: "" },
      focusedGroupId: "empty",
    })!;
    expect(applyTileAction(loneEmpty, { type: "close-group", groupId: "empty" })).toBe(loneEmpty);
    expect(
      applyTileAction(empty, {
        type: "merge-groups",
        groupId: "chooser-group",
        targetGroupId: "conversation-group",
      }),
    ).toBe(empty);
    const restored = parseTileLayout(JSON.parse(JSON.stringify(empty)));
    expect(restored).toEqual(empty);
    expect(syncTileLayout(restored, [], [], null, false)).toEqual(empty);
    const chosen = syncTileLayout(restored, [], ["files"], "files", true);
    expect(getTileGroups(chosen).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID],
      ["files"],
    ]);
    expect(getTileGroups(chosen)[1]?.activeTabId).toBe("files");
    expect(chosen.focusedGroupId).toBe("chooser-group");
    expect(syncTileLayout(chosen, ["files"], [], null, false)).toEqual(initial);
    const anotherChooser = applyTileAction(chosen, {
      type: "new-group",
      targetGroupId: "conversation-group",
      axis: "vertical",
      side: "after",
      groupId: "another-chooser",
      splitId: "another-split",
    });
    const existingChosen = syncTileLayout(anotherChooser, ["files"], ["files"], "files", true);
    expect(getTileGroups(existingChosen).map((group) => [group.id, group.tabs])).toEqual([
      ["conversation-group", [CONVERSATION_TAB_ID]],
      ["another-chooser", ["files"]],
    ]);
    expect(existingChosen.focusedGroupId).toBe("another-chooser");
    expect(getTileGroups(existingChosen)[1]?.activeTabId).toBe("files");
    const moved = applyTileAction(chosen, {
      type: "move",
      tabId: "files",
      targetGroupId: "conversation-group",
    });
    expect(getTileGroups(moved).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID, "files"],
    ]);
    const swapped = applyTileAction(empty, {
      type: "swap-groups",
      firstGroupId: "chooser-group",
      secondGroupId: "conversation-group",
    });
    expect(getTileGroups(swapped)).toEqual(getTileGroups(empty).toReversed());
    const docked = applyTileAction(swapped, {
      type: "dock-group",
      groupId: "chooser-group",
      targetGroupId: "conversation-group",
      axis: "vertical",
      side: "after",
      splitId: "docked-chooser",
    });
    expect(getTileGroups(docked)).toEqual(getTileGroups(empty));
    expect(parseTileLayout(JSON.parse(JSON.stringify(docked)))).toEqual(docked);
    for (const [targetGroupId, groupId, splitId] of [
      ["missing", "empty", "split"],
      ["conversation-group", "conversation-group", "split"],
      ["conversation-group", "empty", "conversation-group"],
      ["conversation-group", "same", "same"],
    ]) {
      expect(
        applyTileAction(initial, {
          type: "new-group",
          targetGroupId: targetGroupId!,
          groupId: groupId!,
          splitId: splitId!,
          axis: "horizontal",
          side: "after",
        }),
      ).toBe(initial);
    }
  });

  it("shows a tile beside the maximized one, swaps them and restores on outside focus", () => {
    let initial = syncTileLayout(undefined, [], ["files", "notes"], "files", true);
    initial = applyTileAction(initial, {
      type: "split",
      tabId: "notes",
      targetGroupId: "panels-group",
      axis: "vertical",
      side: "after",
      groupId: "notes-group",
      splitId: "notes-split",
    });
    expect(applyTileAction(initial, { type: "show-beside", groupId: "panels-group" })).toBe(
      initial,
    );
    const maximized = applyTileAction(initial, { type: "maximize", groupId: "conversation-group" });
    expect(applyTileAction(maximized, { type: "show-beside", groupId: "conversation-group" })).toBe(
      maximized,
    );
    expect(applyTileAction(maximized, { type: "show-beside", groupId: "missing" })).toBe(maximized);
    const paired = applyTileAction(maximized, { type: "show-beside", groupId: "panels-group" });
    expect([paired.maximizedGroupId, paired.besideGroupId, paired.focusedGroupId]).toEqual([
      "conversation-group",
      "panels-group",
      "panels-group",
    ]);
    expect(parseTileLayout(JSON.parse(JSON.stringify(paired)))).toEqual(paired);
    const swapped = applyTileAction(paired, { type: "swap-beside" });
    expect([swapped.maximizedGroupId, swapped.besideGroupId]).toEqual([
      "panels-group",
      "conversation-group",
    ]);
    expect(applyTileAction(maximized, { type: "swap-beside" })).toBe(maximized);
    expect(
      applyTileAction(paired, { type: "activate", groupId: "panels-group", tabId: "files" })
        .besideGroupId,
    ).toBe("panels-group");
    const outside = applyTileAction(paired, { type: "focus", groupId: "notes-group" });
    expect([outside.maximizedGroupId, outside.besideGroupId]).toEqual([null, undefined]);
    const restored = applyTileAction(paired, { type: "maximize", groupId: null });
    expect(restored).toEqual({ ...initial, focusedGroupId: "panels-group" });
    expect(applyTileAction(paired, { type: "show-beside", groupId: null })).toEqual({
      ...maximized,
      focusedGroupId: "panels-group",
    });
    const closedBeside = syncTileLayout(paired, ["files", "notes"], ["notes"], "notes", false);
    expect([closedBeside.maximizedGroupId, closedBeside.besideGroupId]).toEqual([
      "conversation-group",
      undefined,
    ]);
    const newArea = syncTileLayout(paired, ["files", "notes"], ["files", "notes", "x"], "x", true);
    expect(getTileGroups(newArea).find((group) => group.tabs.includes("x"))?.id).toBe(
      "panels-group",
    );
    expect(newArea.besideGroupId).toBe("panels-group");
    expect(parseTileLayout({ ...paired, maximizedGroupId: null })?.besideGroupId).toBeUndefined();
    expect(parseTileLayout({ ...paired, focusPairRatio: 12 })?.focusPairRatio).toBe(0.9);
    expect(applyTileAction(paired, { type: "resize-focus-pair", ratio: NaN })).toBe(paired);
  });

  it("preserves independent active tabs while external activation selects the owning group", () => {
    let layout = syncTileLayout(undefined, [], ["a", "b"], "a", true);
    layout = applyTileAction(layout, {
      type: "move",
      tabId: "b",
      targetGroupId: "conversation-group",
    });
    layout = syncTileLayout(layout, ["a", "b"], ["a", "b", "c"], "c", true);
    expect(getTileGroups(layout).map((group) => group.activeTabId)).toEqual(["c", "a"]);
    layout = syncTileLayout(layout, ["a", "b", "c"], ["a", "b", "c"], "a", true);
    expect(layout.focusedGroupId).toBe("panels-group");
    expect(getTileGroups(layout).map((group) => group.activeTabId)).toEqual(["c", "a"]);
    const focused = applyTileAction(layout, { type: "focus", groupId: "conversation-group" });
    expect(
      syncTileLayout(focused, ["a", "b", "c"], ["a", "b", "c"], "a", false).focusedGroupId,
    ).toBe("conversation-group");
  });

  it("closing a tab only changes its own group's active tab", () => {
    let layout = syncTileLayout(undefined, [], ["side", "browser"], "browser", true);
    layout = applyTileAction(layout, {
      type: "move",
      tabId: "side",
      targetGroupId: "conversation-group",
    });
    layout = applyTileAction(layout, {
      type: "activate",
      groupId: "conversation-group",
      tabId: CONVERSATION_TAB_ID,
    });
    layout = applyTileAction(layout, { type: "focus", groupId: "panels-group" });
    // The store falls back to the next surface in its flat list, which lives in the other group.
    const closed = syncTileLayout(layout, ["side", "browser"], ["side"], "side", true);
    expect(getTileGroups(closed).map((group) => [group.id, group.activeTabId])).toEqual([
      ["conversation-group", CONVERSATION_TAB_ID],
    ]);
    let three = syncTileLayout(undefined, [], ["a", "b", "c"], "b", true);
    three = applyTileAction(three, { type: "activate", groupId: "panels-group", tabId: "b" });
    expect(
      getTileGroups(syncTileLayout(three, ["a", "b", "c"], ["a", "c"], "a", true))[1]?.activeTabId,
    ).toBe("c");
  });

  it("prunes closed groups and restores a usable conversation after maximizing", () => {
    let layout = syncTileLayout(undefined, [], ["a"], "a", true);
    layout = applyTileAction(layout, { type: "maximize", groupId: "panels-group" });
    expect(layout.maximizedGroupId).toBe("panels-group");
    layout = applyTileAction(layout, { type: "resize", splitId: "initial-split", ratio: 0.7 });
    expect(layout.root.kind === "split" && layout.root.ratio).toBe(0.7);
    layout = syncTileLayout(layout, ["a"], [], null, false);
    expect(getTileGroups(layout).map((group) => group.tabs)).toEqual([[CONVERSATION_TAB_ID]]);
    expect(layout.maximizedGroupId).toBeNull();
  });

  it("restores the layout when activating or focusing a group outside the maximized tile", () => {
    const initial = syncTileLayout(undefined, [], ["a"], "a", true);
    const maximized = applyTileAction(initial, { type: "maximize", groupId: "panels-group" });
    expect(
      applyTileAction(maximized, {
        type: "activate",
        groupId: "conversation-group",
        tabId: CONVERSATION_TAB_ID,
      }).maximizedGroupId,
    ).toBeNull();
    expect(
      applyTileAction(maximized, { type: "focus", groupId: "conversation-group" }).maximizedGroupId,
    ).toBeNull();
    expect(
      applyTileAction(maximized, { type: "activate", groupId: "panels-group", tabId: "a" })
        .maximizedGroupId,
    ).toBe("panels-group");
  });

  it("rejects malformed or cyclic persisted trees and repairs duplicate or obsolete tabs", () => {
    const raw = {
      root: {
        kind: "group",
        id: "g",
        tabs: ["conversation", "conversation", "gone"],
        activeTabId: "gone",
      },
      focusedGroupId: "missing",
      maximizedGroupId: "missing",
    };
    const parsed = parseTileLayout(raw);
    expect(parsed).toBeDefined();
    expect(parsed && getTileGroups(parsed)[0]?.colorIndex).toBe(0);
    expect(
      getTileGroups(parseTileLayout({ ...raw, root: { ...raw.root, colorIndex: 7 } })!)[0]
        ?.colorIndex,
    ).toBe(7);
    for (const colorIndex of [-1, 8, 1.5, "blue"]) {
      expect(
        getTileGroups(parseTileLayout({ ...raw, root: { ...raw.root, colorIndex } })!)[0]
          ?.colorIndex,
      ).toBe(0);
    }
    const legacySplit = syncTileLayout(undefined, [], ["a"], "a", true);
    legacySplit.root = {
      kind: "split",
      id: "legacy",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "group", id: "first", tabs: ["conversation"], activeTabId: "conversation" },
      second: { kind: "group", id: "second", tabs: ["a"], activeTabId: "a", colorIndex: 0 },
    };
    expect(getTileGroups(parseTileLayout(legacySplit)!).map((group) => group.colorIndex)).toEqual([
      1, 0,
    ]);
    expect(getTileGroups(syncTileLayout(parsed, [], [], null, false))[0]?.tabs).toEqual([
      CONVERSATION_TAB_ID,
    ]);
    const cycle: Record<string, unknown> = {
      kind: "split",
      id: "cycle",
      axis: "horizontal",
      ratio: 0.5,
    };
    cycle.first = cycle;
    cycle.second = raw.root;
    expect(parseTileLayout({ ...raw, root: cycle })).toBeUndefined();
    expect(parseTileLayout({ ...raw, root: { ...raw.root, tabs: [] } })).toBeUndefined();
  });
});
