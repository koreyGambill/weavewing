import * as Schema from "effect/Schema";

const PersistedToolSidebar = Schema.Struct({
  visible: Schema.Boolean,
  activeTool: Schema.NullOr(Schema.Literals(["calendar", "status"])),
  width: Schema.Finite,
});

export interface ToolSidebarState extends Schema.Schema.Type<typeof PersistedToolSidebar> {
  maximized: boolean;
}

export const INITIAL_TOOL_SIDEBAR: ToolSidebarState = {
  visible: false,
  activeTool: null,
  width: 300,
  maximized: false,
};

export type ToolSidebarAction =
  | { type: "toggle" }
  | { type: "select"; tool: NonNullable<ToolSidebarState["activeTool"]> }
  | { type: "collapse" }
  | { type: "maximize" }
  | { type: "restore" }
  | { type: "resize"; width: number };

function clampToolSidebarWidth(width: number) {
  return Number.isFinite(width) ? Math.min(600, Math.max(280, width)) : 300;
}

export function resolveToolSidebarWidth(width: number, availableWidth: number) {
  return Math.min(width, Math.max(280, availableWidth - 364));
}

const decodePersistedToolSidebar = Schema.decodeUnknownOption(PersistedToolSidebar);

export function restoreToolSidebar(value: unknown): ToolSidebarState {
  const parsed = decodePersistedToolSidebar(value);
  return parsed._tag === "Some"
    ? { ...parsed.value, width: clampToolSidebarWidth(parsed.value.width), maximized: false }
    : INITIAL_TOOL_SIDEBAR;
}

export function transitionToolSidebar(
  state: ToolSidebarState,
  action: ToolSidebarAction,
): ToolSidebarState {
  switch (action.type) {
    case "toggle":
      return { ...state, visible: !state.visible, maximized: false };
    case "select":
      return {
        ...state,
        visible: true,
        activeTool: state.visible && state.activeTool === action.tool ? null : action.tool,
        maximized: false,
      };
    case "collapse":
      return { ...state, activeTool: null, maximized: false };
    case "maximize":
      return state.visible && state.activeTool ? { ...state, maximized: !state.maximized } : state;
    case "restore":
      return { ...state, maximized: false };
    case "resize":
      return { ...state, width: clampToolSidebarWidth(action.width) };
  }
}
