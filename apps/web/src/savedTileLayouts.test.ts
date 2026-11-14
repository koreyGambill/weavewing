import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TILE_LAYOUTS,
  ProjectId,
  type SavedTileNode,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTileLayoutFromSaved,
  resolveDefaultTileLayout,
  toSavedTileNode,
} from "./savedTileLayouts";
import {
  CONVERSATION_TAB_ID,
  getTileGroups,
  parseTileLayout,
  syncTileLayout,
  type ThreadTileLayout,
} from "./threadTileLayout";

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
          tabs: [CONVERSATION_TAB_ID],
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
});
