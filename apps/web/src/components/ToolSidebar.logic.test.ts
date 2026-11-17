import { describe, expect, it } from "vite-plus/test";
import {
  INITIAL_TOOL_SIDEBAR,
  restoreToolSidebar,
  resolveToolSidebarWidth,
  transitionToolSidebar,
} from "./ToolSidebar.logic";

describe("tool sidebar", () => {
  it("keeps the rail reachable when a wide saved page meets a narrow workspace", () => {
    expect(resolveToolSidebarWidth(600, 544)).toBe(280);
    expect(resolveToolSidebarWidth(600, 1024)).toBe(600);
    expect(resolveToolSidebarWidth(300, 1024)).toBe(300);
  });

  it("restores the rail and selected page after hiding", () => {
    const rail = transitionToolSidebar(INITIAL_TOOL_SIDEBAR, { type: "toggle" });
    expect(rail).toMatchObject({ visible: true, activeTool: null });
    expect(
      transitionToolSidebar(transitionToolSidebar(rail, { type: "toggle" }), { type: "toggle" }),
    ).toEqual(rail);
    const expanded = transitionToolSidebar(rail, { type: "select", tool: "calendar" });
    expect(expanded).toMatchObject({ visible: true, activeTool: "calendar" });
    const hidden = transitionToolSidebar(expanded, { type: "toggle" });
    expect(hidden).toMatchObject({ visible: false, activeTool: "calendar" });
    expect(transitionToolSidebar(hidden, { type: "toggle" })).toEqual(expanded);
    expect(transitionToolSidebar(expanded, { type: "select", tool: "calendar" })).toEqual(rail);
  });

  it("restores size after maximize and exits maximize when collapsing or hiding", () => {
    const expanded = transitionToolSidebar(INITIAL_TOOL_SIDEBAR, {
      type: "select",
      tool: "calendar",
    });
    const maximized = transitionToolSidebar(expanded, { type: "maximize" });
    expect(maximized.maximized).toBe(true);
    expect(transitionToolSidebar(maximized, { type: "restore" })).toEqual(expanded);
    expect(transitionToolSidebar(maximized, { type: "maximize" })).toEqual(expanded);
    expect(transitionToolSidebar(maximized, { type: "collapse" })).toMatchObject({
      activeTool: null,
      maximized: false,
    });
    expect(transitionToolSidebar(maximized, { type: "toggle" })).toMatchObject({
      visible: false,
      maximized: false,
    });
    expect(transitionToolSidebar(INITIAL_TOOL_SIDEBAR, { type: "maximize" })).toEqual(
      INITIAL_TOOL_SIDEBAR,
    );
  });

  it("reloads persisted visibility, selection and bounded width without retaining maximize", () => {
    expect(
      restoreToolSidebar({ visible: false, activeTool: "calendar", width: 360, maximized: true }),
    ).toEqual({ visible: false, activeTool: "calendar", width: 360, maximized: false });
    expect(restoreToolSidebar({ visible: true, activeTool: null, width: 10 }).width).toBe(280);
    expect(restoreToolSidebar({ visible: true, activeTool: "calendar", width: 900 }).width).toBe(
      600,
    );
    expect(
      restoreToolSidebar({ visible: true, activeTool: "status", width: 320, maximized: true }),
    ).toEqual({ visible: true, activeTool: "status", width: 320, maximized: false });
    const status = transitionToolSidebar(INITIAL_TOOL_SIDEBAR, { type: "select", tool: "status" });
    expect(status).toMatchObject({ visible: true, activeTool: "status" });
    expect(transitionToolSidebar(status, { type: "select", tool: "calendar" }).activeTool).toBe(
      "calendar",
    );
    expect(transitionToolSidebar(status, { type: "select", tool: "status" }).activeTool).toBeNull();
    expect(
      transitionToolSidebar(transitionToolSidebar(status, { type: "toggle" }), { type: "toggle" }),
    ).toEqual(status);
    expect(restoreToolSidebar({ activeTool: "missing" })).toEqual(INITIAL_TOOL_SIDEBAR);
    expect(transitionToolSidebar(INITIAL_TOOL_SIDEBAR, { type: "resize", width: 340 }).width).toBe(
      340,
    );
  });
});
