import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TILE_LAYOUTS,
  ProjectId,
  ServerSettings,
  type SavedTileNode,
  type SavedTileViewNode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTileLayoutFromSaved,
  resolveDefaultTileLayout,
  savedLayoutTree,
  savedTileLayoutTrees,
  tileLayoutDeletePatch,
  toSavedTileNode,
} from "./savedTileLayouts";
import {
  CONVERSATION_TAB_ID,
  getTileGroups,
  newTabId,
  parseTileLayout,
  syncTileLayout,
  type ThreadTileLayout,
} from "./threadTileLayout";

// Builds without views know only these areas and no `viewRoot`.
const olderNode: Schema.Codec<unknown> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("group"),
    areas: Schema.Array(
      Schema.Literals([
        "device",
        "side-chat",
        "pull-request",
        "chat",
        "browser",
        "terminal",
        "files",
        "notes",
        "diff",
        "pull-requests",
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  Schema.Struct({
    kind: Schema.Literal("split"),
    axis: Schema.Literals(["horizontal", "vertical"]),
    ratio: Schema.Number,
    first: Schema.suspend(() => olderNode),
    second: Schema.suspend(() => olderNode),
  }),
]);
const decodeOlderLayouts = Schema.decodeUnknownSync(
  Schema.Struct({
    tileLayouts: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, root: olderNode }),
    ),
  }),
);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

const sequentialIds = () => {
  let next = 0;
  return () => `id${next++}`;
};
const chatNotesTerminal = DEFAULT_TILE_LAYOUTS[0]!.root;

describe("saved tile layouts", () => {
  it("saves docked areas and split ratios, dropping targeted tabs, floating tiles and empty tiles", () => {
    const layout: ThreadTileLayout = {
      focusedGroupId: "a",
      maximizedGroupId: "a",
      root: {
        kind: "split",
        id: "s1",
        axis: "horizontal",
        ratio: 0.3,
        first: {
          kind: "group",
          id: "a",
          tabs: [
            CONVERSATION_TAB_ID,
            newTabId("blank-a"),
            newTabId("blank-b"),
            newTabId("blank-c"),
          ],
          activeTabId: CONVERSATION_TAB_ID,
        },
        second: {
          kind: "split",
          id: "s2",
          axis: "vertical",
          ratio: 0.6,
          first: {
            kind: "group",
            id: "b",
            tabs: ["terminal:t1", "pull-request:x", "browser:tab"],
            activeTabId: "terminal:t1",
          },
          second: {
            kind: "split",
            id: "s3",
            axis: "horizontal",
            ratio: 0.5,
            first: { kind: "group", id: "c", tabs: ["side-chat:z"], activeTabId: "side-chat:z" },
            second: {
              kind: "group",
              id: "d",
              tabs: ["files"],
              activeTabId: "files",
              floating: { x: 0, y: 0, width: 0.5, height: 0.5 },
            },
          },
        },
      },
    };
    expect(toSavedTileNode(layout)).toEqual({
      dropped: true,
      root: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.3,
        first: { kind: "group", areas: ["chat"] },
        second: { kind: "group", areas: ["terminal", "browser"] },
      },
    });
  });

  it("lays out a fresh thread with placeholders that new surfaces fill in their own tiles", () => {
    const built = buildTileLayoutFromSaved(chatNotesTerminal, [], sequentialIds());
    const [chat, notes, terminal] = getTileGroups(built);
    expect(chat?.tabs).toEqual([CONVERSATION_TAB_ID]);
    expect(built.focusedGroupId).toBe(chat?.id);
    expect(built.pendingAreas).toEqual({
      [notes!.tabs[0]!]: "notes",
      [terminal!.tabs[0]!]: "terminal",
    });
    expect(parseTileLayout(JSON.parse(JSON.stringify(built)))?.pendingAreas).toEqual(
      built.pendingAreas,
    );
    // Saving before the areas open keeps them as the areas they wait for.
    expect(toSavedTileNode(built)).toEqual({ root: chatNotesTerminal, dropped: false });
    // Terminal opens while the draft exists; Notes waits for the thread.
    const withTerminal = syncTileLayout(built, [], ["terminal:fresh"], "terminal:fresh", true);
    expect(getTileGroups(withTerminal).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID],
      notes!.tabs,
      ["terminal:fresh"],
    ]);
    expect(Object.values(withTerminal.pendingAreas ?? {})).toEqual(["notes"]);
    const withNotes = syncTileLayout(
      withTerminal,
      ["terminal:fresh"],
      ["terminal:fresh", "notes"],
      "notes",
      true,
    );
    expect(getTileGroups(withNotes).map((group) => group.tabs)).toEqual([
      [CONVERSATION_TAB_ID],
      ["notes"],
      ["terminal:fresh"],
    ]);
    expect(withNotes.pendingAreas).toBeUndefined();
  });

  it("saves and restores views, dropping views locked to another thread and views that no longer exist", () => {
    const layout: ThreadTileLayout = {
      focusedGroupId: "a",
      maximizedGroupId: null,
      root: {
        kind: "split",
        id: "s1",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "group", id: "a", tabs: [CONVERSATION_TAB_ID], activeTabId: "conversation" },
        second: {
          kind: "group",
          id: "b",
          tabs: ["view:todos", "view:links:env:other", "view:status"],
          activeTabId: "view:todos",
        },
      },
    };
    const saved = toSavedTileNode(layout);
    expect(saved).toEqual({
      dropped: true,
      root: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "group", areas: ["chat"] },
        second: { kind: "group", areas: ["view:todos", "view:status"] },
      },
    });
    const withRetired: SavedTileViewNode = {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "group", areas: ["chat", "view:retired"] },
      second: { kind: "group", areas: ["view:todos", "view:retired", "view:status"] },
    };
    const built = buildTileLayoutFromSaved(withRetired, [], sequentialIds());
    const [chat, views] = getTileGroups(built);
    expect(chat?.tabs).toEqual([CONVERSATION_TAB_ID]);
    expect(Object.values(built.pendingAreas ?? {})).toEqual(["view:todos", "view:status"]);
    expect(parseTileLayout(JSON.parse(JSON.stringify(built)))?.pendingAreas).toEqual(
      built.pendingAreas,
    );
    const filled = syncTileLayout(built, [], ["view:todos", "view:status"], "view:status", true);
    expect(getTileGroups(filled)[1]?.tabs).toEqual(["view:todos", "view:status"]);
    expect(views?.tabs).toHaveLength(2);
    expect(filled.pendingAreas).toBeUndefined();
  });

  it("stores views beside a view-free tree that builds without views decode and keep", () => {
    const tree: SavedTileViewNode = {
      kind: "split",
      axis: "horizontal",
      ratio: 0.4,
      first: { kind: "group", areas: ["chat", "view:links"] },
      second: {
        kind: "split",
        axis: "vertical",
        ratio: 0.5,
        first: { kind: "group", areas: ["view:todos"] },
        second: { kind: "group", areas: ["terminal"] },
      },
    };
    const saved = { id: "views", name: "With views", ...savedTileLayoutTrees(tree) };
    const viewFree: SavedTileNode = {
      kind: "split",
      axis: "horizontal",
      ratio: 0.4,
      first: { kind: "group", areas: ["chat"] },
      second: { kind: "group", areas: ["terminal"] },
    };
    expect(saved).toEqual({ id: "views", name: "With views", root: viewFree, viewRoot: tree });
    const stored = JSON.parse(
      JSON.stringify(encodeServerSettings({ ...DEFAULT_SERVER_SETTINGS, tileLayouts: [saved] })),
    );
    // This build reads its views back.
    const reread = decodeServerSettings(stored).tileLayouts[0]!;
    expect(savedLayoutTree(reread)).toEqual(tree);
    // Builds without views keep the view-free tree.
    const older = decodeOlderLayouts(stored);
    expect(older.tileLayouts).toEqual([{ id: "views", name: "With views", root: viewFree }]);
    // An older build that saves settings drops `viewRoot`; this build then lays out the view-free tree.
    const afterOlderSave = decodeServerSettings({
      ...stored,
      tileLayouts: older.tileLayouts,
    }).tileLayouts[0]!;
    expect(savedLayoutTree(afterOlderSave)).toEqual(viewFree);
    // A layout of views alone keeps the chat as its view-free tree.
    expect(savedTileLayoutTrees({ kind: "group", areas: ["view:status"] }).root).toEqual({
      kind: "group",
      areas: ["chat"],
    });
    expect(savedTileLayoutTrees(viewFree)).toEqual({ root: viewFree });
  });

  it("forgets a placeholder the user closed or replaced", () => {
    const built = buildTileLayoutFromSaved(chatNotesTerminal, [], sequentialIds());
    const [, notes] = getTileGroups(built);
    const closed = syncTileLayout(
      {
        ...built,
        root: JSON.parse(JSON.stringify(built.root).replace(`"${notes!.tabs[0]}"`, '"files"')),
      },
      [],
      ["files"],
      null,
      false,
    );
    expect(Object.values(closed.pendingAreas ?? {})).toEqual(["terminal"]);
  });

  it("applies to an open thread by reusing its surfaces and keeping every tab", () => {
    const saved: SavedTileNode = {
      kind: "split",
      axis: "vertical",
      ratio: 0.7,
      first: { kind: "group", areas: ["terminal", "terminal"] },
      second: { kind: "group", areas: ["chat"] },
    };
    const built = buildTileLayoutFromSaved(
      saved,
      ["terminal:one", "pull-request:x", "notes"],
      sequentialIds(),
    );
    const [terminals, chat] = getTileGroups(built);
    expect(terminals?.tabs[0]).toBe("terminal:one");
    expect(built.pendingAreas).toEqual({ [terminals!.tabs[1]!]: "terminal" });
    expect(chat?.tabs).toEqual([CONVERSATION_TAB_ID, "pull-request:x", "notes"]);
  });

  it("puts chat first in the first tile when a layout has no chat area", () => {
    const built = buildTileLayoutFromSaved(
      { kind: "group", areas: ["files"] },
      ["files"],
      sequentialIds(),
    );
    expect(getTileGroups(built)[0]).toMatchObject({
      tabs: [CONVERSATION_TAB_ID, "files"],
      activeTabId: CONVERSATION_TAB_ID,
    });
  });

  it("gives a tile whose areas are already taken a New tab", () => {
    const built = buildTileLayoutFromSaved(
      {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "group", areas: ["chat"] },
        second: { kind: "group", areas: ["chat"] },
      },
      [],
      sequentialIds(),
    );
    const [, second] = getTileGroups(built);
    expect(second).toMatchObject({
      tabs: [newTabId(second!.id)],
      activeTabId: newTabId(second!.id),
    });
  });

  it("resolves the project default over the global one, honouring an explicit none", () => {
    const project = ProjectId.make("project");
    const other = { id: "other", name: "Other", root: { kind: "group", areas: ["chat"] } } as const;
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      tileLayouts: [...DEFAULT_TILE_LAYOUTS, other],
      defaultTileLayoutId: "chat-notes-terminal",
    };
    expect(resolveDefaultTileLayout(DEFAULT_SERVER_SETTINGS, project)).toBeNull();
    expect(resolveDefaultTileLayout(settings, project)?.id).toBe("chat-notes-terminal");
    expect(
      resolveDefaultTileLayout(
        { ...settings, projectSettingsOverrides: { [project]: { defaultTileLayoutId: "other" } } },
        project,
      )?.id,
    ).toBe("other");
    expect(
      resolveDefaultTileLayout(
        { ...settings, projectSettingsOverrides: { [project]: { defaultTileLayoutId: null } } },
        project,
      ),
    ).toBeNull();
    expect(
      resolveDefaultTileLayout(
        {
          ...settings,
          projectSettingsOverrides: { [project]: { defaultTileLayoutId: "deleted" } },
        },
        project,
      )?.id,
    ).toBe("chat-notes-terminal");
    expect(
      resolveDefaultTileLayout({ ...settings, defaultTileLayoutId: "deleted" }, null),
    ).toBeNull();
  });

  it("deletes a layout together with the global and every project default naming it", () => {
    const [kept, removed] = [ProjectId.make("kept"), ProjectId.make("removed")];
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultTileLayoutId: "chat-notes-terminal",
      projectSettingsOverrides: {
        [kept]: { defaultTileLayoutId: "other" },
        [removed]: { defaultTileLayoutId: "chat-notes-terminal", defaultAutoPull: false },
      },
    };
    expect(tileLayoutDeletePatch(settings, "chat-notes-terminal")).toEqual({
      tileLayouts: [],
      defaultTileLayoutId: null,
      projectSettingsOverrides: { [removed]: { defaultAutoPull: false } },
    });
    expect(tileLayoutDeletePatch(settings, "other")).toEqual({
      tileLayouts: DEFAULT_TILE_LAYOUTS,
      projectSettingsOverrides: { [kept]: null },
    });
  });
});
