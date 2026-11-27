import { describe, expect, it, vi } from "vite-plus/test";

const SIDE_KEY = "weavewing_tool_sidebar";
const RAIL_KEY = "t3code:thread-context-sidebar";

function memoryStorage(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => void values.set(name, value),
    removeItem: (name: string) => void values.delete(name),
  };
}

const stored = (state: object, version: number) => JSON.stringify({ state, version });
const read = (value: string | undefined) => {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return value;
  }
};
const rail = (view: string, lastTool: string) =>
  stored({ view, lastTool, hidden: ["inbox"], todoFilter: "you", todoScope: "thread" }, 2);
// The side panel's stored shape before this version, which had no version or thread view.
const basePanel = (open: boolean, view: string) =>
  stored({ open, view, width: 480, pinned: false, locked: null }, 0);

/** Loads both stores as the app does at start, from `storage`. */
async function load(storage: ReturnType<typeof memoryStorage>) {
  vi.resetModules();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
  const { useThreadContextSidebarStore } = await import("./threadContextSidebarStore");
  const { useToolSidebarStore } = await import("./toolSidebarStore");
  vi.unstubAllGlobals();
  const panel = useToolSidebarStore.getState();
  return {
    panel: { open: panel.open, view: panel.view, width: panel.width, threadView: panel.threadView },
    views: useThreadContextSidebarStore.getState(),
    railStored: read(storage.values.get(RAIL_KEY)),
  };
}

describe("upgrading from the left rail", () => {
  it.each([
    [
      "no side panel stored",
      { [RAIL_KEY]: rail("links", "links") },
      { open: true, view: "links", width: 300, threadView: "links" },
    ],
    [
      "a closed side panel saved on Calendar",
      { [RAIL_KEY]: rail("links", "links"), [SIDE_KEY]: basePanel(false, "calendar") },
      { open: true, view: "links", width: 480, threadView: "links" },
    ],
    [
      "an open side panel saved on Status",
      { [RAIL_KEY]: rail("todos", "todos"), [SIDE_KEY]: basePanel(true, "status") },
      { open: true, view: "status", width: 480, threadView: "checklist" },
    ],
    [
      "the rail on the thread list",
      { [RAIL_KEY]: rail("threads", "environments"), [SIDE_KEY]: basePanel(false, "calendar") },
      { open: false, view: "calendar", width: 480, threadView: "details" },
    ],
    [
      "an unreadable side panel",
      { [RAIL_KEY]: rail("inbox", "timeline"), [SIDE_KEY]: "{not json" },
      { open: true, view: "inbox", width: 300, threadView: "activity" },
    ],
  ])("carries the rail's selection over with %s", async (_case, entries, panel) => {
    const storage = memoryStorage(entries);
    const loaded = await load(storage);
    expect(loaded.panel).toEqual(panel);
    expect(loaded.views).toMatchObject({ todoFilter: "you" });
    expect(loaded.railStored).toMatchObject({ version: 3 });
    expect(loaded.railStored.state).not.toHaveProperty("view");
    expect(loaded.railStored.state).not.toHaveProperty("lastTool");
  });

  it("hands the selection over once, not again on the next load", async () => {
    const storage = memoryStorage({ [RAIL_KEY]: rail("artifacts", "artifacts") });
    const first = await load(storage);
    expect(first.panel).toMatchObject({ open: true, view: "artifacts" });
    const { useToolSidebarStore } = await import("./toolSidebarStore");
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("HTMLElement", Object);
    useToolSidebarStore.getState().dispatch({ type: "close" });
    vi.unstubAllGlobals();
    expect(JSON.parse(storage.values.get(SIDE_KEY) ?? "null")).toMatchObject({ version: 1 });
    // The rail's old snapshot coming back, as from an older build in another tab, does not reopen it.
    storage.values.set(RAIL_KEY, rail("links", "links"));
    const second = await load(storage);
    expect(second.panel).toMatchObject({ open: false, view: "artifacts", threadView: "artifacts" });
  });

  it("stores Checklist and Activity under the ids older builds know and reads them back", async () => {
    const storage = memoryStorage({});
    await load(storage);
    const { useToolSidebarStore } = await import("./toolSidebarStore");
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("HTMLElement", Object);
    useToolSidebarStore.getState().dispatch({ type: "show", view: "activity" });
    useToolSidebarStore.getState().dispatch({ type: "show", view: "status" });
    expect(read(storage.values.get(SIDE_KEY))?.state).toMatchObject({
      view: "status",
      threadView: "timeline",
    });
    useToolSidebarStore.getState().dispatch({ type: "show", view: "checklist" });
    vi.unstubAllGlobals();
    expect(read(storage.values.get(SIDE_KEY))?.state).toMatchObject({
      view: "todos",
      threadView: "todos",
    });
    const reloaded = await load(storage);
    expect(reloaded.panel).toMatchObject({
      open: true,
      view: "checklist",
      threadView: "checklist",
    });
  });

  it("starts both stores fresh from unreadable rail state", async () => {
    const loaded = await load(memoryStorage({ [RAIL_KEY]: "{not json" }));
    expect(loaded.panel).toEqual({
      open: false,
      view: "details",
      width: 300,
      threadView: "details",
    });
    expect(loaded.views).toMatchObject({ todoFilter: "all", todoScope: "thread" });
  });
});

it.each([
  [[], []],
  [["related"], []],
  [["links", "related"], ["links"]],
  [["details", "environments", "context"], ["details"]],
  [
    ["inbox", "calendar", "status", "unrecognized"],
    ["inbox", "calendar", "status"],
  ],
  [
    ["todos", "artifacts", "links", "related", "timeline", "details", "environments", "inspect"],
    ["artifacts", "links", "activity", "details"],
  ],
])("migrates and reloads picker visibility from the old rail list %j", async (hidden, expected) => {
  const storage = memoryStorage({
    [RAIL_KEY]: stored({ view: "threads", lastTool: "todos", hidden }, 2),
  });
  await load(storage);
  expect(read(storage.values.get(SIDE_KEY))?.state.hidden).toEqual(expected);
  await load(storage);
  const { useToolSidebarStore } = await import("./toolSidebarStore");
  expect(useToolSidebarStore.getState().hidden).toEqual(expected);
});
