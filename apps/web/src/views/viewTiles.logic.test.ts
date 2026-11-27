import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeStoredViewTabId,
  restoreViewSurface,
  viewIdFromArea,
  viewSurface,
  viewTabTitle,
  viewTileThread,
} from "./viewTiles.logic";

const owner = scopeThreadRef("env" as EnvironmentId, ThreadId.make("owner"));
const other = scopeThreadRef("env" as EnvironmentId, ThreadId.make("other"));

describe("view tiles", () => {
  it("locks a thread view to the thread it showed, and only names a thread other than the tile's", () => {
    expect(viewSurface("checklist", owner, owner)).toEqual({
      id: "view:todos",
      kind: "view",
      viewId: "checklist",
    });
    const locked = viewSurface("links", owner, other);
    expect(locked).toEqual({
      id: "view:links:env:other",
      kind: "view",
      viewId: "links",
      threadRef: other,
    });
    expect(viewTileThread(locked, owner)).toEqual(other);
    expect(viewTileThread(viewSurface("checklist", owner, null), owner)).toEqual(owner);
    // Global views span threads: no lock, no thread.
    const status = viewSurface("status", owner, other);
    expect(status).toEqual({ id: "view:status", kind: "view", viewId: "status" });
    expect(viewTileThread(status, owner)).toBeNull();
  });

  it("titles a view tab with the locked thread only when it shows another thread", () => {
    expect(viewTabTitle("Activity", null)).toBe("Activity");
    expect(viewTabTitle("Activity", "Fix the build")).toBe("Activity · Fix the build");
  });

  it("reads saved view areas and recognises views that no longer exist", () => {
    expect(viewIdFromArea("view:todos")).toBe("checklist");
    expect(viewIdFromArea("notes")).toBeNull();
    expect(viewIdFromArea("view:retired")).toBeNull();
    expect(viewIdFromArea("view:related")).toBe("links");
    expect(viewIdFromArea("view:activity")).toBe("activity");
    expect(normalizeStoredViewTabId("view:activity:env:other")).toBe("view:timeline:env:other");
  });

  it("keeps a migrated Checklist tab when the store reads it again", () => {
    const saved = { id: "view:todos", kind: "view", viewId: "todos" };
    const restored = restoreViewSurface(saved);
    expect(restored).toEqual(viewSurface("checklist", owner, owner));
    expect(restoreViewSurface(restored)).toEqual(restored);
  });
});
