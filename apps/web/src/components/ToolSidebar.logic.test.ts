import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  adoptRetiredRail,
  describeLockedThread,
  INITIAL_SIDE_AREA,
  migrateViewId,
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
  it("lists the thread views, then Inbox, Calendar and Status", () => {
    expect(VIEW_IDS).toEqual([
      "todos",
      "evidence",
      "artifacts",
      "links",
      "related",
      "timeline",
      "details",
      "environments",
      "inspect",
      "automations",
      "inbox",
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
      { type: "show", view: "todos" },
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

  it("opens a view about a thread following it, locked only on request", () => {
    const lockedB = run(INITIAL_SIDE_AREA, { type: "lock", thread: threadB });
    expect(run(lockedB, { type: "show", view: "todos", thread: threadA })).toMatchObject({
      open: true,
      view: "todos",
      locked: null,
    });
    expect(run(lockedB, { type: "show", view: "links", thread: threadB }).locked).toEqual(threadB);
    expect(
      run(INITIAL_SIDE_AREA, { type: "show", view: "todos", thread: threadA, lock: true }).locked,
    ).toEqual(threadA);
    expect(run(lockedB, { type: "show", view: "inbox" }).locked).toEqual(threadB);
  });

  it("keeps a view opened for a thread being navigated to, once, and closes on other switches", () => {
    const opened = run(INITIAL_SIDE_AREA, {
      type: "show",
      view: "artifacts",
      thread: threadB,
      arriving: true,
    });
    const arrived = run(opened, { type: "routeChanged", threadKey: "env:b" });
    expect(arrived).toMatchObject({ open: true, view: "artifacts", arrival: null });
    expect(run(arrived, { type: "routeChanged", threadKey: "env:a" }).open).toBe(false);
    expect(run(opened, { type: "routeChanged", threadKey: "env:a" })).toMatchObject({
      open: false,
      arrival: null,
    });
    const pinned = run(INITIAL_SIDE_AREA, { type: "show", view: "links" }, { type: "pin" });
    expect(run(pinned, { type: "routeChanged", threadKey: "env:a" }).open).toBe(true);
  });

  it("toggles thread views on the last one shown, skipping global views", () => {
    const toggle = { type: "toggleThreadViews" } as const;
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
      width: 640,
      maximized: false,
      threadView: "links",
      arrival: null,
    });
    expect(restoreSideArea({ ...stored, view: "status", threadView: "inspect" })).toMatchObject({
      view: "status",
      threadView: "inspect",
    });
    expect(restoreSideArea({ ...stored, view: "context" }).view).toBe("inspect");
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

  it("gives the details card to the first host showing the selected thread", () => {
    const first = { threadRef: threadA, element: "first" };
    const second = { threadRef: threadB, element: "second" };
    expect(resolveDetailsDestination([first, second], threadB)).toBe(second);
    expect(resolveDetailsDestination([first, second], threadA)).toBe(first);
    const secondOnA = { threadRef: threadA, element: "second" };
    expect(resolveDetailsDestination([first, secondOnA], threadA)).toBe(first);
    expect(resolveDetailsDestination([null, second], threadA)).toBe(second);
    expect(resolveDetailsDestination([null, null], threadA)).toBeNull();
  });

  it.each([
    ["todos", "todos"],
    ["evidence", "evidence"],
    ["artifacts", "artifacts"],
    ["links", "links"],
    ["related", "related"],
    ["timeline", "timeline"],
    ["details", "details"],
    ["environments", "environments"],
    ["inspect", "inspect"],
    ["automations", "automations"],
    ["inbox", "inbox"],
    ["calendar", "calendar"],
    ["status", "status"],
    ["marks", "links"],
    ["ticket", "links"],
    ["context", "inspect"],
    ["threads", null],
    ["status-sources", null],
    [42, null],
    [undefined, null],
  ])("migrates the stored view id %o to %o", (stored, expected) => {
    expect(migrateViewId(stored)).toBe(expected);
  });

  it.each([
    [
      { view: "evidence", lastTool: "evidence" },
      { open: true, view: "evidence", threadView: "evidence" },
    ],
    [
      { view: "inbox", lastTool: "timeline" },
      { open: true, view: "inbox", threadView: "timeline" },
    ],
    [
      { view: "threads", lastTool: "inspect" },
      { open: false, view: "details", threadView: "inspect" },
    ],
    [
      { view: "threads", lastTool: "context" },
      { open: false, view: "details", threadView: "inspect" },
    ],
    [
      { view: "threads", lastTool: "gone" },
      { open: false, view: "details", threadView: "details" },
    ],
    [{}, { open: false, view: "details", threadView: "details" }],
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
