import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  adoptRetiredRail,
  describeLockedThread,
  INITIAL_SIDE_AREA,
  migrateViewId,
  migrateViewTarget,
  resolveDetailsDestination,
  resolveSideAreaThread,
  resolveSideAreaWidth,
  resolveViewLayout,
  restoreSideArea,
  transitionSideArea,
  VIEW_IDS,
  type SideAreaAction,
  type SideAreaState,
} from "./ToolSidebar.logic";

const threadA = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("a") };
const threadB = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("b") };

const run = (state: SideAreaState, ...actions: SideAreaAction[]) =>
  actions.reduce(transitionSideArea, state);

describe("side area", () => {
  it("keeps the strip open independently of its floating view", () => {
    const initial = INITIAL_SIDE_AREA;
    expect(initial).toMatchObject({ open: false, stripVisible: true });
    const links = { type: "pressStripView", view: "links" } as const;
    const activity = { type: "pressStripView", view: "activity" } as const;
    const opened = run(initial, links);
    expect(opened).toMatchObject({ open: true, view: "links", stripVisible: true });
    expect(run(opened, links)).toMatchObject({ open: false, stripVisible: true });
    const switched = run(opened, activity);
    expect(switched).toMatchObject({ open: true, view: "activity", stripVisible: true });
    const maximized = run(switched, { type: "maximize" });
    expect(maximized.maximized).toBe(true);
    expect(run(maximized, { type: "maximize" }).maximized).toBe(false);
    const hidden = run(maximized, { type: "toggleStrip" });
    expect(hidden).toMatchObject({ open: false, stripVisible: false, maximized: false });
    expect(run(hidden, { type: "toggleStrip" })).toMatchObject({ open: false, stripVisible: true });
    expect(restoreSideArea(hidden).stripVisible).toBe(false);
  });

  it("hides an icon while keeping its view open and accessible", () => {
    const shown = run(INITIAL_SIDE_AREA, { type: "pressStripView", view: "links" });
    const hidden = run(shown, { type: "setHidden", view: "links", hidden: true, strip: true });
    expect(hidden).toMatchObject({ open: true, view: "links", hidden: ["links"] });
    expect(run(hidden, { type: "setHidden", view: "links", hidden: false }).hidden).toEqual([]);
  });
  it("lists five thread views, then the views that span threads", () => {
    expect(VIEW_IDS).toEqual([
      "checklist",
      "artifacts",
      "links",
      "activity",
      "details",
      "waiting",
      "inbox",
      "evidence",
      "automations",
      "calendar",
      "status",
    ]);
  });

  it("renders views compact below the breakpoint or the view's own threshold", () => {
    expect(resolveViewLayout(undefined, { wide: true, width: 280 })).toBe("full");
    expect(resolveViewLayout(undefined, { wide: false, width: 600 })).toBe("compact");
    expect(resolveViewLayout(400, { wide: true, width: 399 })).toBe("compact");
    expect(resolveViewLayout(400, { wide: true, width: 400 })).toBe("full");
  });

  it("keeps 320 px of content beside a wide saved width in a narrow workspace", () => {
    expect(resolveSideAreaWidth(640, 544)).toBe(280);
    expect(resolveSideAreaWidth(640, 924)).toBe(604);
    expect(resolveSideAreaWidth(640, 1280)).toBe(640);
    expect(resolveSideAreaWidth(300, 1024)).toBe(300);
  });

  it("closes on a click outside or a thread switch unless pinned", () => {
    const open = run(INITIAL_SIDE_AREA, { type: "show", view: "links" });
    expect(run(open, { type: "dismiss" })).toMatchObject({ open: false, view: "links" });
    const pinned = run(open, { type: "pin" });
    expect(run(pinned, { type: "dismiss" })).toEqual(pinned);
    expect(run(pinned, { type: "close" }).open).toBe(false);
    expect(run(pinned, { type: "pin" }, { type: "dismiss" }).open).toBe(false);
  });

  it("locks to a thread independently of the pin and returns to following when unlocked", () => {
    const locked = run(
      INITIAL_SIDE_AREA,
      { type: "show", view: "checklist" },
      { type: "lock", thread: threadA },
    );
    expect(resolveSideAreaThread(locked.locked, threadB)).toEqual(threadA);
    expect(locked.pinned).toBe(false);
    expect(run(locked, { type: "dismiss" })).toMatchObject({ open: false, locked: threadA });
    const both = run(locked, { type: "pin" });
    expect(run(both, { type: "dismiss" })).toMatchObject({
      open: true,
      pinned: true,
      locked: threadA,
    });
    const unlocked = run(both, { type: "lock", thread: null });
    expect(resolveSideAreaThread(unlocked.locked, threadB)).toEqual(threadB);
    expect(unlocked.pinned).toBe(true);
  });

  it("toggles Details for the row's thread and takes over a lock on another thread", () => {
    const details = { type: "toggleView", view: "details", thread: threadA } as const;
    const opened = run(INITIAL_SIDE_AREA, { type: "show", view: "calendar" }, details);
    expect(opened).toMatchObject({ open: true, view: "details" });
    expect(run(opened, details).open).toBe(false);
    const lockedElsewhere = run(opened, { type: "lock", thread: threadB }, details);
    expect(lockedElsewhere).toMatchObject({ open: true, view: "details", locked: null });
    const lockedHere = run(opened, { type: "lock", thread: threadA }, details);
    expect(lockedHere.open).toBe(false);
  });

  it("opens a view for a thread, following it when the side area does and locking otherwise", () => {
    const followingA = { route: threadA, selected: threadA };
    const lockedB = run(INITIAL_SIDE_AREA, { type: "lock", thread: threadB });
    const show = (
      thread: typeof threadA,
      context: { route: typeof threadA; selected: typeof threadA },
    ) => ({ type: "show", view: "checklist", thread, context }) as const;
    expect(run(lockedB, show(threadA, followingA))).toMatchObject({
      open: true,
      view: "checklist",
      locked: null,
    });
    // The route shows A while a side chat of it, B, is focused: a view for A locks to A.
    expect(
      run(INITIAL_SIDE_AREA, show(threadA, { route: threadA, selected: threadB })).locked,
    ).toEqual(threadA);
    expect(run(INITIAL_SIDE_AREA, show(threadB, followingA)).locked).toEqual(threadB);
    expect(run(lockedB, { type: "show", view: "inbox" }).locked).toEqual(threadB);
  });

  it("settles a view opened while navigating on arrival, against the thread followed there", () => {
    const opened = run(INITIAL_SIDE_AREA, {
      type: "show",
      view: "artifacts",
      thread: threadB,
      arriving: true,
      context: { route: threadA, selected: threadA },
    });
    expect(opened).toMatchObject({ open: true, arrival: threadB, locked: null });
    const arrived = run(opened, {
      type: "routeChanged",
      context: { route: threadB, selected: threadB },
    });
    expect(arrived).toMatchObject({ open: true, view: "artifacts", arrival: null, locked: null });
    const intoSideChat = run(opened, {
      type: "routeChanged",
      context: { route: threadB, selected: threadA },
    });
    expect(intoSideChat).toMatchObject({ open: true, arrival: null, locked: threadB });
    const elsewhere = { route: threadA, selected: threadA };
    expect(run(arrived, { type: "routeChanged", context: elsewhere }).open).toBe(false);
    expect(run(opened, { type: "routeChanged", context: elsewhere })).toMatchObject({
      open: false,
      arrival: null,
    });
    // Already there: nothing to wait for, so it settles at once.
    const here = run(INITIAL_SIDE_AREA, {
      type: "show",
      view: "artifacts",
      thread: threadB,
      arriving: true,
      context: { route: threadB, selected: threadA },
    });
    expect(here).toMatchObject({ arrival: null, locked: threadB });
    const pinned = run(INITIAL_SIDE_AREA, { type: "show", view: "links" }, { type: "pin" });
    expect(run(pinned, { type: "routeChanged", context: elsewhere }).open).toBe(true);
  });

  it("toggles thread views on the last one shown, skipping global views", () => {
    const toggle = { type: "toggleThreadViews", collapsedSections: [] } as const;
    expect(run(INITIAL_SIDE_AREA, toggle)).toMatchObject({ open: true, view: "details" });
    const links = run(INITIAL_SIDE_AREA, { type: "show", view: "links" });
    expect(run(links, toggle).open).toBe(false);
    const status = run(links, { type: "show", view: "status" });
    expect(status.threadView).toBe("links");
    expect(run(status, toggle)).toMatchObject({ open: true, view: "links" });
    expect(run(links, { type: "close" }, toggle)).toMatchObject({ open: true, view: "links" });
  });

  it("maximizes only while open and leaves maximize when closing", () => {
    expect(run(INITIAL_SIDE_AREA, { type: "maximize" })).toEqual(INITIAL_SIDE_AREA);
    const maximized = run(
      INITIAL_SIDE_AREA,
      { type: "show", view: "status" },
      { type: "maximize" },
    );
    expect(maximized.maximized).toBe(true);
    expect(run(maximized, { type: "restore" }).maximized).toBe(false);
    expect(run(maximized, { type: "toggle" })).toMatchObject({ open: false, maximized: false });
    expect(run(maximized, { type: "dismiss" })).toMatchObject({ open: false, maximized: false });
  });

  it("restores stored state with a bounded width and without maximize", () => {
    const stored = { open: true, view: "links", width: 900, pinned: true, locked: threadA };
    expect(restoreSideArea({ ...stored, maximized: true })).toEqual({
      ...stored,
      stripVisible: true,
      width: 640,
      maximized: false,
      threadView: "links",
      threadSection: null,
      hidden: [],
      revealSection: null,
      arrival: null,
    });
    expect(restoreSideArea({ ...stored, view: "status", threadView: "timeline" })).toMatchObject({
      view: "status",
      threadView: "activity",
    });
    expect(restoreSideArea({ ...stored, view: "context" }).view).toBe("details");
    expect(restoreSideArea({ ...stored, width: 10 }).width).toBe(280);
    expect(restoreSideArea({ ...stored, view: "missing" })).toEqual(INITIAL_SIDE_AREA);
    expect(restoreSideArea({ ...stored, locked: { threadId: 3 } })).toEqual(INITIAL_SIDE_AREA);
    expect(restoreSideArea(null)).toEqual(INITIAL_SIDE_AREA);
  });

  it.each([
    [
      { visible: true, activeTool: null, width: 470 },
      { open: true, view: "status", width: 470 },
    ],
    [
      { visible: true, activeTool: "status", width: 590 },
      { open: true, view: "status", width: 590 },
    ],
    [
      { visible: true, activeTool: "calendar", width: 300 },
      { open: true, view: "calendar", width: 300 },
    ],
    [
      { visible: false, activeTool: "calendar", width: 1000 },
      { open: false, view: "calendar", width: 640 },
    ],
    [
      { visible: false, activeTool: "status", width: 10 },
      { open: false, view: "status", width: 280 },
    ],
    [
      { visible: false, activeTool: null, width: 300 },
      { open: false, view: "details", width: 300 },
    ],
  ])("migrates the tools sidebar's stored %o", (stored, expected) => {
    expect(restoreSideArea(stored)).toEqual({ ...INITIAL_SIDE_AREA, ...expected });
  });

  it("starts fresh from a tools sidebar state it cannot read", () => {
    expect(restoreSideArea({ visible: true, activeTool: "missing", width: 300 })).toEqual(
      INITIAL_SIDE_AREA,
    );
    expect(restoreSideArea({ visible: true, activeTool: null })).toEqual(INITIAL_SIDE_AREA);
    expect(restoreSideArea({ visible: "yes", activeTool: null, width: 300 })).toEqual(
      INITIAL_SIDE_AREA,
    );
  });

  it("gives the selected thread's Details card to its first visible tile, then the panel", () => {
    const tile = { threadRef: threadA, element: "tile", host: "tile" } as const;
    const otherTile = { threadRef: threadB, element: "other", host: "tile" } as const;
    const panel = { threadRef: threadA, element: "panel", host: "panel" } as const;
    expect(resolveDetailsDestination([tile, otherTile, panel], threadA)).toBe(tile);
    expect(resolveDetailsDestination([otherTile, tile, panel], threadA)).toBe(tile);
    expect(resolveDetailsDestination([tile, otherTile, panel], threadB)).toBe(otherTile);
    expect(resolveDetailsDestination([otherTile, panel], threadA)).toBe(panel);
    expect(resolveDetailsDestination([otherTile], threadA)).toBeNull();
    expect(resolveDetailsDestination([tile, panel], null)).toBeNull();
    expect(resolveDetailsDestination([], threadA)).toBeNull();
  });

  it.each([
    ["todos", { view: "checklist" }],
    ["evidence", { view: "evidence" }],
    ["artifacts", { view: "artifacts" }],
    ["links", { view: "links" }],
    ["related", { view: "links", section: "links:threads" }],
    ["timeline", { view: "activity", section: "activity:runs" }],
    ["details", { view: "details" }],
    ["environments", { view: "details", section: "details:environments" }],
    ["inspect", { view: "details", section: "details:inspect" }],
    ["automations", { view: "automations" }],
    ["inbox", { view: "inbox" }],
    ["calendar", { view: "calendar" }],
    ["status", { view: "status" }],
    ["checklist", { view: "checklist" }],
    ["activity", { view: "activity" }],
    ["marks", { view: "links", section: "links:links" }],
    ["ticket", { view: "links", section: "links:links" }],
    ["context", { view: "details", section: "details:inspect" }],
    ["threads", null],
    ["toString", null],
    ["status-sources", null],
    [42, null],
    [undefined, null],
  ])("migrates the stored view id %o to %o", (stored, expected) => {
    expect(migrateViewTarget(stored)).toEqual(expected);
    expect(migrateViewId(stored)).toBe(expected?.view ?? null);
  });

  it.each([
    [
      { view: "evidence", lastTool: "evidence" },
      { open: true, view: "evidence" },
    ],
    [
      { view: "todos", lastTool: "todos" },
      { open: true, view: "checklist", threadView: "checklist" },
    ],
    [
      { view: "inbox", lastTool: "timeline" },
      { open: true, view: "inbox", threadView: "activity", threadSection: "activity:runs" },
    ],
    [
      { view: "related", lastTool: "related" },
      {
        open: true,
        view: "links",
        threadView: "links",
        threadSection: "links:threads",
        revealSection: "links:threads",
      },
    ],
    [
      { view: "threads", lastTool: "inspect" },
      { open: false, view: "details", threadSection: "details:inspect" },
    ],
    [
      { view: "threads", lastTool: "automations" },
      { open: false, view: "details" },
    ],
    [
      { view: "threads", lastTool: "gone" },
      { open: false, view: "details" },
    ],
    [{}, { open: false, view: "details" }],
  ])("opens the left rail's stored %o in the side panel", (rail, expected) => {
    expect(adoptRetiredRail(INITIAL_SIDE_AREA, rail)).toEqual({
      ...INITIAL_SIDE_AREA,
      ...expected,
    });
  });

  it("keeps an open side panel's view when the rail showed another", () => {
    const status = { ...INITIAL_SIDE_AREA, open: true, view: "status" } as const;
    expect(adoptRetiredRail(status, { view: "links", lastTool: "links" })).toEqual({
      ...status,
      threadView: "links",
    });
  });

  it("names a locked thread from its shell, then its own read, and reports a deletion", () => {
    expect(describeLockedThread({ shellTitle: "Live", detail: null })).toEqual({
      kind: "named",
      title: "Live",
      archived: false,
    });
    expect(
      describeLockedThread({
        shellTitle: null,
        detail: { status: "live", title: "Old work", archived: true },
      }),
    ).toEqual({ kind: "named", title: "Old work", archived: true });
    expect(
      describeLockedThread({
        shellTitle: null,
        detail: { status: "deleted", title: "Gone", archived: false },
      }),
    ).toEqual({ kind: "deleted" });
    expect(
      describeLockedThread({
        shellTitle: null,
        detail: { status: "synchronizing", title: null, archived: false },
      }),
    ).toEqual({ kind: "loading" });
  });
});
