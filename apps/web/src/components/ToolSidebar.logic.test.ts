import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  describeLockedThread,
  INITIAL_SIDE_AREA,
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
  it("lists the rail's thread views, then Inbox, Calendar and Status", () => {
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
    });
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

  it("gives the details card to the host showing the selected thread, the side area on a tie", () => {
    const side = { threadRef: threadA, element: "side" };
    const rail = { threadRef: threadB, element: "rail" };
    expect(resolveDetailsDestination({ side, rail, selected: threadB })).toBe(rail);
    expect(resolveDetailsDestination({ side, rail, selected: threadA })).toBe(side);
    const railOnA = { threadRef: threadA, element: "rail" };
    expect(resolveDetailsDestination({ side, rail: railOnA, selected: threadA })).toBe(side);
    expect(resolveDetailsDestination({ side: null, rail, selected: threadA })).toBe(rail);
    expect(resolveDetailsDestination({ side: null, rail: null, selected: threadA })).toBeNull();
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
