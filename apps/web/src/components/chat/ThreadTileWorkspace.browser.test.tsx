import { BackgroundThreadContext } from "./backgroundThread";
import { useState } from "react";
import { WorkspaceTitlebarControlsHost } from "../WorkspaceTitlebar";
import { dispatchMenuAction } from "../../shortcuts/dispatcher";
import {
  compileResolvedKeybindingsConfig,
  defaultKeybindingsForMode,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import "../../index.css";
import {
  DEFAULT_TILE_LAYOUTS,
  EnvironmentId,
  ThreadId,
  type SavedTileLayout,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import {
  selectThreadRightPanelState,
  selectThreadTileLayout,
  useRightPanelStore,
} from "../../rightPanelStore";
import { getTileGroups, isNewTab, newTabId, TILE_MIN_WIDTH_PX } from "../../threadTileLayout";
import { ThreadTileWorkspace } from "./ThreadTileWorkspace";

const tabTitles = vi.hoisted(() => new Map<string, string>());
vi.mock("../SurfaceTabContent", () => ({
  SurfaceIcon: () => null,
  surfaceTitle: (surface: { id: string; kind: string }) =>
    tabTitles.get(surface.id) ?? surface.kind,
}));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
const savedLayouts = vi.hoisted(() => ({ effectiveDefault: null as SavedTileLayout | null }));
vi.mock("./useSavedTileLayouts", () => ({
  useSavedTileLayouts: () => ({
    layouts: [],
    globalDefaultId: null,
    projectId: null,
    projectDefaultId: undefined,
    effectiveDefault: savedLayouts.effectiveDefault,
    save: () => {},
    setGlobalDefault: () => {},
    setProjectDefault: () => {},
  }),
}));

async function setup(resizeScenario = false, newThread = false, leader = false) {
  const keybindings = leader
    ? DEFAULT_RESOLVED_KEYBINDINGS
    : compileResolvedKeybindingsConfig(defaultKeybindingsForMode(false));
  savedLayouts.effectiveDefault = newThread ? DEFAULT_TILE_LAYOUTS[0]! : null;
  tabTitles.clear();
  await using resources = new AsyncDisposableStack();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1100, 800);
  resources.defer(() => page.viewport(viewport.width, viewport.height));

  const threadRef = {
    environmentId: EnvironmentId.make("tiles"),
    threadId: ThreadId.make("mount-preservation"),
  };
  useRightPanelStore.setState({ byThreadKey: {} });
  const store = useRightPanelStore.getState();
  if (!newThread) {
    store.open(threadRef, "files");
    store.open(threadRef, "diff");
  }
  if (resizeScenario) {
    store.closeSurface(threadRef, "files");
    store.applyTileAction(threadRef, {
      type: "move",
      tabId: "diff",
      targetGroupId: "conversation-group",
    });
    store.openTerminal(threadRef, "new-terminal");
    store.applyTileAction(threadRef, {
      type: "split",
      tabId: "terminal:new-terminal",
      targetGroupId: "conversation-group",
      axis: "horizontal",
      side: "after",
      groupId: "terminal-group",
      splitId: "terminal-split",
    });
  }
  const noop = () => {};
  function Harness() {
    const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
    const panel = useRightPanelStore((state) =>
      selectThreadRightPanelState(state.byThreadKey, threadRef),
    );
    const workspace = (
      <ThreadTileWorkspace
        threadRef={threadRef}
        projectId={null}
        newThread={newThread}
        header={<header style={{ height: 32 }}>Thread header</header>}
        runningTerminalIds={[]}
        onCloseTileSurfaces={(surfaces) => {
          for (const surface of surfaces) store.closeSurface(threadRef, surface.id);
        }}
        conversation={<textarea aria-label="Conversation draft" defaultValue="" />}
        panels={{
          surfaces: panel.surfaces,
          activeSurfaceId: panel.activeSurfaceId,
          environmentId: threadRef.environmentId,
          keybindings,
          getShortcutContext: () => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          }),
          pendingSurfaceIds: new Set(),
          previewSessions: {},
          desktopByTabId: {},
          terminalLabelsById: new Map(),
          onActivate: (surface) => store.activateSurface(threadRef, surface.id),
          onCloseSurface: (surface) => store.closeSurface(threadRef, surface.id),
          onCloseOtherSurfaces: noop,
          onCloseSurfacesToRight: noop,
          onCloseAllSurfaces: noop,
          onCopyFilePath: noop,
          onAddBrowser: noop,
          onAddBrowserInProfile: noop,
          onAddTerminal: () => store.openTerminal(threadRef, "new-terminal"),
          onAddDiff: noop,
          onAddFiles: noop,
          onAddNotes: () => store.add(threadRef, "notes"),
          onAddPullRequest: noop,
          onAddPullRequests: noop,
          onAddDevice: noop,
          browserAvailable: false,
          terminalAvailable: true,
          diffAvailable: false,
          filesAvailable: false,
          pullRequestAvailable: false,
          pullRequestsAvailable: false,
          deviceAvailable: false,
        }}
        renderSurface={(surface) => (
          <textarea
            data-terminal-owner={surface.kind === "terminal" ? "right-panel" : undefined}
            aria-label={surface.kind === "notes" ? "Editor notes" : `Editor ${surface.id}`}
            defaultValue=""
          />
        )}
      />
    );
    return (
      <WorkspaceTitlebarControlsHost value={controlsHost}>
        <div ref={setControlsHost} aria-label="Title bar controls" />
        {workspace}
      </WorkspaceTitlebarControlsHost>
    );
  }
  const screen = resources.use(
    await render(
      <div style={{ display: "flex", width: "min(900px, 100vw)", height: 600 }}>
        <Harness />
      </div>,
    ),
  );
  const selectTab = async (name: string) => {
    const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (element) => element.getAttribute("aria-label") === name,
    );
    if (tab && !tab.checkVisibility({ visibilityProperty: true })) {
      const active = tab
        .closest("[data-tile-group]")!
        .querySelector('[role="tab"][aria-selected="true"]')!
        .getAttribute("aria-label");
      await userEvent.click(
        screen
          .getByRole("region", { name: `Tile: ${active}`, exact: true })
          .getByRole("button", { name: "Tile actions", exact: true }),
      );
      await userEvent.hover(screen.getByRole("menuitem", { name: "Switch tab", exact: true }));
      await userEvent.click(screen.getByRole("menuitem", { name, exact: true }));
    } else {
      await userEvent.click(screen.getByRole("tab", { name, exact: true }));
    }
  };
  const newTile = async (where: "right" | "below") => {
    await userEvent.click(
      screen.getByRole("button", { name: "Tile actions", exact: true }).first(),
    );
    await userEvent.click(
      screen.getByRole("menuitem", {
        name: where === "right" ? /New tile to the right/ : /New tile below/,
      }),
    );
  };
  const layout = () => selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, threadRef);
  const owned = resources.move();
  return {
    screen,
    workspace: <Harness />,
    store,
    threadRef,
    layout,
    selectTab,
    newTile,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

it("keeps conversation and editor contents mounted through grouping, splitting and maximizing", async () => {
  await using fixture = await setup();
  const { screen, store, threadRef, layout, selectTab, newTile } = fixture;
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Conversation draft" }),
    "unfinished conversation",
  );
  await selectTab("files");
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Editor files" }),
    "unsaved editor contents",
  );
  const conversation = getTileGroups(layout()).find((group) =>
    group.tabs.includes("conversation"),
  )!;
  store.applyTileAction(threadRef, {
    type: "move",
    tabId: "files",
    targetGroupId: conversation.id,
  });
  await expect
    .element(screen.getByRole("textbox", { name: "Editor files" }))
    .toHaveValue("unsaved editor contents");
  store.applyTileAction(threadRef, {
    type: "split",
    tabId: "files",
    targetGroupId: conversation.id,
    axis: "vertical",
    side: "after",
    groupId: "editor-tile",
    splitId: "editor-split",
  });
  await expect
    .element(screen.getByRole("textbox", { name: "Editor files" }))
    .toHaveValue("unsaved editor contents");
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation draft" }))
    .toHaveValue("unfinished conversation");
  store.applyTileAction(threadRef, { type: "maximize", groupId: "editor-tile" });
  await expect
    .element(screen.getByRole("textbox", { name: "Editor files" }))
    .toHaveValue("unsaved editor contents");
  await userEvent.click(screen.getByRole("button", { name: "Restore tiles" }));
  expect(layout().maximizedGroupId).toBeNull();
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation draft" }))
    .toHaveValue("unfinished conversation");
  await newTile("right");
  await expect.element(screen.getByText("Choose an area", { exact: true })).toBeVisible();
  const chooser = getTileGroups(layout()).find((group) => group.tabs.every(isNewTab))!;
  expect(
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces.filter((surface) => surface.kind === "terminal"),
  ).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Terminal", exact: true }));
  expect(getTileGroups(layout()).find((group) => group.id === chooser.id)?.tabs).toContain(
    "terminal:new-terminal",
  );
  await userEvent.click(screen.getByRole("button", { name: "New tab", exact: true }).nth(0));
  await expect.element(screen.getByRole("tab", { name: "New tab", exact: true })).toBeVisible();
  await userEvent.keyboard("t");
  await expect
    .element(screen.getByRole("tab", { name: "New tab", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("textbox", { name: "Editor terminal:new-terminal" }))
    .toBeVisible();
  // The region supplies coordinates; its floating content and drop overlay receive the drag.
  await userEvent.dragAndDrop(
    screen.getByRole("tab", { name: "files", exact: true }),
    screen.getByRole("region", { name: "Tile: diff", exact: true }),
    { force: true },
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Editor files" }))
    .toHaveValue("unsaved editor contents");
  expect(getTileGroups(layout()).find((group) => group.tabs.includes("files"))?.tabs).toContain(
    "diff",
  );
  const tabGroupId = layout().focusedGroupId;
  await userEvent.keyboard("{Control>}{Tab}{/Control}");
  expect(getTileGroups(layout()).find((group) => group.id === tabGroupId)?.activeTabId).toBe(
    "diff",
  );
  // Focus follows into the shown tab, rather than dropping to the page with the hidden one.
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-tile-content")).toBe("diff"),
  );
  await userEvent.keyboard("{Control>}{Shift>}{Tab}{/Shift}{/Control}");
  expect(getTileGroups(layout()).find((group) => group.id === tabGroupId)?.activeTabId).toBe(
    "files",
  );
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-tile-content")).toBe("files"),
  );
  await newTile("right");
  await expect.element(screen.getByText("Choose an area", { exact: true })).toBeVisible();
  const empty = getTileGroups(layout()).find((group) => group.tabs.every(isNewTab))!;
  expect(empty).toBeDefined();
  expect(
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces.filter((surface) => surface.kind === "terminal"),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Close empty tile", exact: true }));
  expect(getTileGroups(layout()).some((group) => group.id === empty.id)).toBe(false);
  await selectTab("Main chat");
  const movedGroup = getTileGroups(layout()).find((group) => group.tabs.includes("files"))!;
  const targetGroup = getTileGroups(layout()).find((group) => group.tabs.includes("conversation"))!;
  await userEvent.dragAndDrop(
    screen.getByRole("toolbar", { name: "Move tile: files", exact: true }),
    screen.getByRole("region", { name: "Tile: Main chat", exact: true }),
    { sourcePosition: { x: 5, y: 12 }, force: true },
  );
  expect(getTileGroups(layout()).findIndex((group) => group.id === movedGroup.id)).toBeLessThan(
    getTileGroups(layout()).findIndex((group) => group.id === targetGroup.id),
  );
  expect(getTileGroups(layout()).find((group) => group.id === movedGroup.id)?.colorIndex).toBe(
    movedGroup.colorIndex,
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Editor files" }))
    .toHaveValue("unsaved editor contents");
  await userEvent.dragAndDrop(
    screen.getByRole("toolbar", { name: "Move tile: files", exact: true }),
    screen.getByRole("toolbar", { name: "Move tile: Main chat", exact: true }),
    { sourcePosition: { x: 5, y: 12 }, force: true },
  );
  expect(getTileGroups(layout()).find((group) => group.tabs.includes("files"))?.tabs).toContain(
    "conversation",
  );
  expect(getTileGroups(layout()).some((group) => group.id === movedGroup.id)).toBe(false);
  // Middle-clicking a tab that doesn't hold focus leaves the caret where the user was typing.
  const elsewhere = document.body.appendChild(document.createElement("input"));
  elsewhere.focus();
  await userEvent.click(screen.getByRole("tab", { name: "files", exact: true }), {
    button: "middle",
  });
  await expect
    .element(screen.getByRole("tab", { name: "files", exact: true }))
    .not.toBeInTheDocument();
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces.some(
      (surface) => surface.id === "files",
    ),
  ).toBe(false);
});

it("resizes, shows tiles beside a maximized one and opens independent area views", async () => {
  await using fixture = await setup(true);
  const { screen, store, threadRef, layout, newTile } = fixture;
  await newTile("right");
  const notesChooser = getTileGroups(layout()).find((group) => group.tabs.every(isNewTab))!;
  await userEvent.click(screen.getByRole("button", { name: "Notes", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Editor notes", exact: true }))
    .toBeVisible();
  const notesId = getTileGroups(layout()).find((group) => group.id === notesChooser.id)!.tabs[0]!;
  expect(notesId).toMatch(/^notes:/);
  const notesRect = screen
    .getByRole("textbox", { name: "Editor notes" })
    .element()
    .getBoundingClientRect();
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      clientX: notesRect.x + notesRect.width / 2,
      clientY: notesRect.y + notesRect.height / 2,
    }),
  );
  const beforeResize = JSON.stringify(layout().root);
  await userEvent.keyboard("{Control>}{Alt>}{r>}");
  await expect.element(screen.getByRole("status", { name: "Resizing focused tile" })).toBeVisible();
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      clientX: notesRect.x + notesRect.width / 2 + 60,
      clientY: notesRect.y + notesRect.height / 2 + 30,
    }),
  );
  expect(JSON.stringify(layout().root)).toBe(beforeResize);
  await userEvent.keyboard("{/r}{/Alt}{/Control}");
  expect(JSON.stringify(layout().root)).not.toBe(beforeResize);
  const committed = JSON.stringify(layout().root);
  await userEvent.keyboard("{Control>}{Alt>}{r>}");
  await expect.element(screen.getByRole("status", { name: "Resizing focused tile" })).toBeVisible();
  await userEvent.keyboard("{ArrowRight}{Escape}{/r}{/Alt}{/Control}");
  expect(JSON.stringify(layout().root)).toBe(committed);
  const focusedBefore = layout().focusedGroupId;
  await userEvent.keyboard("{Control>}{Alt>}h{/Alt}{/Control}");
  expect(layout().focusedGroupId).not.toBe(focusedBefore);
  store.applyTileAction(threadRef, { type: "focus", groupId: notesChooser.id });
  const fullTree = JSON.stringify(layout().root);
  const notesElement = screen.getByRole("textbox", { name: "Editor notes" }).element();
  await userEvent.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
  expect(layout().maximizedGroupId).toBe(notesChooser.id);
  expect(document.querySelectorAll("section.workspace-tile-frame")).toHaveLength(1);
  await userEvent.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
  await userEvent.click(screen.getByRole("menuitem", { name: /terminal$/ }));
  expect(layout().besideGroupId).toBe("terminal-group");
  expect(document.querySelectorAll("section.workspace-tile-frame")).toHaveLength(2);
  // Nothing in the pair lies left of notes, so the move restores the layout to reach the chat.
  store.applyTileAction(threadRef, { type: "focus", groupId: notesChooser.id });
  await userEvent.keyboard("{Control>}{Alt>}h{/Alt}{/Control}");
  expect([layout().maximizedGroupId, layout().focusedGroupId]).toEqual([
    null,
    "conversation-group",
  ]);
  store.applyTileAction(threadRef, { type: "focus", groupId: notesChooser.id });
  await userEvent.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
  await userEvent.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
  await userEvent.click(screen.getByRole("menuitem", { name: /terminal$/ }));
  expect(layout().besideGroupId).toBe("terminal-group");
  await userEvent.keyboard("{Control>}{Alt>}s{/Alt}{/Control}");
  expect([layout().maximizedGroupId, layout().besideGroupId]).toEqual([
    "terminal-group",
    notesChooser.id,
  ]);
  expect(screen.getByRole("textbox", { name: "Editor notes" }).element()).toBe(notesElement);
  await userEvent.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
  expect([layout().maximizedGroupId, layout().besideGroupId]).toEqual([null, undefined]);
  await userEvent.click(screen.getByRole("textbox", { name: "Editor notes" }));
  await userEvent.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
  expect(layout().maximizedGroupId).toBe(notesChooser.id);
  const restoreButton = screen
    .getByRole("button", { name: "Restore tiles", exact: true })
    .element();
  restoreButton.focus();
  await userEvent.keyboard("{Escape}");
  expect(layout().maximizedGroupId).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).not.toBe(restoreButton));
  expect(JSON.stringify(layout().root)).toBe(fullTree);
  expect(document.querySelectorAll("section.workspace-tile-frame")).toHaveLength(3);

  const beforeNativeResize = JSON.stringify(layout().root);
  dispatchMenuAction("workspace.tile.resize");
  await expect.element(screen.getByRole("status", { name: "Resizing focused tile" })).toBeVisible();
  await userEvent.keyboard("{Control>}{Alt>}{ArrowLeft}");
  await expect.element(screen.getByRole("status", { name: "Resizing focused tile" })).toBeVisible();
  window.dispatchEvent(
    new KeyboardEvent("keyup", { key: "r", code: "KeyR", ctrlKey: true, altKey: true }),
  );
  await userEvent.keyboard("{/Alt}{/Control}");
  expect(JSON.stringify(layout().root)).not.toBe(beforeNativeResize);
  // The first tile is now too narrow to halve side by side.
  await newTile("below");
  const secondNotesGroup = getTileGroups(layout()).find((group) => group.tabs.every(isNewTab))!;
  await userEvent.click(screen.getByRole("button", { name: "Notes", exact: true }));
  expect(
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces.filter((surface) => surface.kind === "notes"),
  ).toHaveLength(2);
  const secondNotesId = getTileGroups(layout()).find((group) => group.id === secondNotesGroup.id)!
    .tabs[0]!;
  expect(secondNotesId).not.toBe(notesId);
  expect(getTileGroups(layout()).find((group) => group.id === notesChooser.id)?.tabs).toContain(
    notesId,
  );
  store.applyTileAction(threadRef, { type: "focus", groupId: secondNotesGroup.id });
  await userEvent.keyboard("{Control>}{Alt>}.{/Alt}{/Control}");
  await userEvent.click(screen.getByRole("menuitem", { name: /^Close tab/ }));
  expect(
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces.filter((surface) => surface.kind === "notes"),
  ).toHaveLength(1);
});

it("moves and resizes floating tiles without docking, and drives the empty chooser by keys", async () => {
  await using fixture = await setup(true);
  const { screen, store, threadRef, layout } = fixture;
  await userEvent.click(
    screen
      .getByRole("region", { name: "Tile: terminal", exact: true })
      .getByRole("button", { name: "Float tile", exact: true }),
  );
  const floated = getTileGroups(layout()).find((group) => group.id === "terminal-group")!;
  expect(floated.floating).toBeDefined();
  const titlebar = screen.getByRole("toolbar", { name: "Move tile: terminal", exact: true });
  const target = screen.getByRole("region", { name: "Tile: Main chat", exact: true });
  const targetRect = target.element().getBoundingClientRect();
  const barRect = titlebar.element().getBoundingClientRect();
  // Over another tile's edge, where the old snapping would have docked it.
  await userEvent.dragAndDrop(titlebar, target, {
    sourcePosition: { x: 4, y: barRect.height / 2 },
    targetPosition: { x: 4, y: targetRect.height / 2 },
    force: true,
  });
  const moved = getTileGroups(layout()).find((group) => group.id === "terminal-group")!;
  expect(moved.floating).toBeDefined();
  expect(moved.floating!.x).not.toBe(floated.floating!.x);
  const corner = screen.getByRole("separator", {
    name: "Resize floating terminal bottom right",
    exact: true,
  });
  await userEvent.dragAndDrop(corner, target, { targetPosition: { x: 10, y: 10 }, force: true });
  const resized = getTileGroups(layout()).find((group) => group.id === "terminal-group")!;
  expect(resized.floating!.width).not.toBe(moved.floating!.width);
  await userEvent.click(
    screen
      .getByRole("region", { name: "Tile: terminal", exact: true })
      .getByRole("button", { name: "Tile actions", exact: true }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: /Dock tile/ }));
  await vi.waitFor(() =>
    expect(
      getTileGroups(layout()).find((group) => group.id === "terminal-group")?.lastFloating,
    ).toEqual(resized.floating),
  );

  store.applyTileAction(threadRef, {
    type: "new-group",
    targetGroupId: "terminal-group",
    axis: "vertical",
    side: "after",
    groupId: "chooser",
    splitId: "chooser-split",
  });
  const mainChat = screen.getByRole("button", { name: "Main chat", exact: true });
  await expect.element(mainChat).toBeVisible();
  // Main chat opens in one tile at a time; choosing it here shows where it is.
  await expect.element(mainChat).toHaveAttribute("aria-disabled", "true");
  // Focus is still on the other tile's Dock button, which keeps its keys.
  await userEvent.keyboard("n");
  expect(getTileGroups(layout()).find((group) => group.id === "chooser")?.tabs).toEqual([
    newTabId("chooser"),
  ]);
  await userEvent.click(
    screen
      .getByRole("region", { name: "Tile: New tab", exact: true })
      .getByRole("button", { name: "New tab", exact: true }),
  );
  await userEvent.keyboard("{Control>}{Alt>}o{/Alt}{/Control}");
  const blanks = getTileGroups(layout()).find((group) => group.id === "chooser")!.tabs;
  expect(blanks).toHaveLength(3);
  expect(new Set(blanks).size).toBe(3);
  for (const tabId of blanks.slice(1))
    store.applyTileAction(threadRef, { type: "close-tab", tabId });
  await userEvent.click(screen.getByText("Choose an area", { exact: true }));
  await userEvent.keyboard("c");
  expect(layout().focusedGroupId).toBe(
    getTileGroups(layout()).find((group) => group.tabs.includes("conversation"))?.id,
  );
  expect(getTileGroups(layout()).find((group) => group.id === "chooser")?.tabs).toEqual([
    newTabId("chooser"),
  ]);
  await userEvent.click(screen.getByText("Choose an area", { exact: true }));
  await userEvent.keyboard("{ArrowRight}{ArrowLeft}n");
  const chosen = getTileGroups(layout()).find((group) => group.id === "chooser")!.tabs[0]!;
  expect(chosen).toMatch(/^notes:/);
  // The chooser unmounts; focus moves into the chosen area rather than dropping to the page.
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-tile-content")).toBe(chosen),
  );
  store.applyTileAction(threadRef, {
    type: "new-group",
    targetGroupId: "terminal-group",
    axis: "vertical",
    side: "after",
    groupId: "escaped",
    splitId: "escaped-split",
  });
  await expect.element(screen.getByText("Choose an area", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByText("Choose an area", { exact: true }));
  await userEvent.keyboard("{Escape}");
  expect(getTileGroups(layout()).some((group) => group.id === "escaped")).toBe(false);
  await vi.waitFor(() => expect(document.activeElement).not.toBe(document.body));
  store.applyTileAction(threadRef, {
    type: "new-group",
    targetGroupId: "terminal-group",
    axis: "vertical",
    side: "after",
    groupId: "tabbed",
    splitId: "tabbed-split",
  });
  await userEvent.click(screen.getByText("Choose an area", { exact: true }));
  // Main chat is highlighted, but Enter on a Tabbed-to choice presses that choice.
  await userEvent.keyboard("{Tab}{Tab}{Tab}{Tab}{Tab}");
  await expect.element(screen.getByRole("button", { name: "Notes", exact: true })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(getTileGroups(layout()).find((group) => group.id === "tabbed")?.tabs[0]).toMatch(
    /^notes:/,
  );
  expect(getTileGroups(layout()).find((group) => group.tabs.includes("conversation"))?.id).toBe(
    "conversation-group",
  );

  store.applyTileAction(threadRef, {
    type: "move",
    tabId: "terminal:new-terminal",
    targetGroupId: "conversation-group",
  });
  await userEvent.click(
    screen
      .getByRole("region", { name: "Tile: terminal", exact: true })
      .getByRole("button", { name: "Close tile", exact: true }),
  );
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(getTileGroups(layout()).some((group) => group.tabs.includes("conversation"))).toBe(false);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces.map(
      (surface) => surface.id,
    ),
  ).not.toContain("terminal:new-terminal");
});

it("lays out a new draft from the default layout, filling placeholders with fresh surfaces", async () => {
  await using fixture = await setup(false, true);
  const tabs = () => getTileGroups(fixture.layout()).map((group) => group.tabs);
  await vi.waitFor(() =>
    expect(tabs()).toEqual([
      ["conversation"],
      [expect.stringMatching(/^notes/)],
      ["terminal:new-terminal"],
    ]),
  );
  expect(fixture.layout().pendingAreas).toBeUndefined();
  // A thread that already has panels keeps its arrangement.
  fixture.store.applyTileAction(fixture.threadRef, {
    type: "move",
    tabId: "terminal:new-terminal",
    targetGroupId: getTileGroups(fixture.layout())[0]!.id,
  });
  const arranged = tabs();
  fixture.store.applySavedTileLayout(fixture.threadRef, DEFAULT_TILE_LAYOUTS[0]!.root, true);
  expect(tabs()).toEqual(arranged);
});

it("keeps the focused tile and its editors when the window becomes narrow", async () => {
  await using fixture = await setup(true);
  const { screen, store, threadRef, layout } = fixture;
  await userEvent.fill(screen.getByRole("textbox", { name: "Conversation draft" }), "chat draft");
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Editor terminal:new-terminal" }),
    "terminal draft",
  );
  store.applyTileAction(threadRef, { type: "focus", groupId: "terminal-group" });
  const tree = JSON.stringify(layout().root);
  await page.viewport(390, 800);
  await vi.waitFor(() =>
    expect(document.querySelectorAll("section.workspace-tile-frame")).toHaveLength(1),
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Editor terminal:new-terminal" }))
    .toHaveValue("terminal draft");
  expect(
    document.querySelector("[data-thread-tiling]")!.getBoundingClientRect().width,
  ).toBeLessThanOrEqual(390);
  await userEvent.click(screen.getByRole("button", { name: "Tile actions", exact: true }));
  await expect
    .element(screen.getByRole("menuitem", { name: /Maximize tile/ }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("menuitem", { name: /Float tile/ }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Switch tile", exact: true }));
  await userEvent.click(screen.getByRole("menuitem", { name: "1: Main chat", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation draft" }))
    .toHaveValue("chat draft");
  await userEvent.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
  await expect
    .element(screen.getByRole("textbox", { name: "Editor terminal:new-terminal" }))
    .toHaveValue("terminal draft");
  await page.viewport(700, 800);
  await userEvent.click(screen.getByRole("button", { name: "Previous tile", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation draft" }))
    .toHaveValue("chat draft");
  await userEvent.click(screen.getByRole("button", { name: "Next tile", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Editor terminal:new-terminal" }))
    .toHaveValue("terminal draft");
  await page.viewport(1100, 800);
  await vi.waitFor(() =>
    expect(document.querySelectorAll("section.workspace-tile-frame")).toHaveLength(2),
  );
  expect(JSON.stringify(layout().root)).toBe(tree);
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation draft" }))
    .toHaveValue("chat draft");
});

type Fixture = Awaited<ReturnType<typeof setup>>;
/** Main chat, diff and notes, then an active New tab, in the left of two side-by-side tiles. */
function fourTabTile({ store, threadRef, layout }: Fixture) {
  store.add(threadRef, "notes");
  const notes = getTileGroups(layout())
    .flatMap((group) => group.tabs)
    .find((tabId) => tabId.startsWith("notes"))!;
  store.applyTileAction(threadRef, {
    type: "move",
    tabId: notes,
    targetGroupId: "conversation-group",
  });
  store.applyTileAction(threadRef, {
    type: "new-tab",
    groupId: "conversation-group",
    tabId: newTabId("last"),
  });
  const tile = () => document.querySelector<HTMLElement>('[data-tile-group="conversation-group"]')!;
  return {
    notes,
    tile,
    shownTabs: () =>
      [...tile().querySelectorAll<HTMLElement>('[role="tab"]')]
        .filter((tab) => tab.checkVisibility({ visibilityProperty: true }))
        .map((tab) => tab.getAttribute("aria-label")),
    shown: (label: string) =>
      tile()
        .querySelector<HTMLElement>(`[aria-label="${label}"]`)
        ?.checkVisibility({ visibilityProperty: true }) ?? false,
    tabFit: (tabId: string) =>
      tile().querySelector<HTMLElement>(`[data-fit-tab="${tabId}"]`)?.dataset.fit,
    resize: (ratio: number) =>
      store.applyTileAction(threadRef, { type: "resize", splitId: "terminal-split", ratio }),
  };
}

it("folds tabs that do not fit into a +N list as a tile narrows, keeping the active tab", async () => {
  await using fixture = await setup(true);
  const { screen, layout } = fixture;
  const { tile, shownTabs, shown, resize } = fourTabTile(fixture);

  resize(0.9);
  await vi.waitFor(() => expect(shownTabs()).toEqual(["Main chat", "diff", "notes", "New tab"]));
  expect(shown("New tile to the right")).toBe(true);
  expect(
    tile().querySelector("[data-fit-chip]")!.checkVisibility({ visibilityProperty: true }),
  ).toBe(false);

  // Controls give way before any tab folds; New tab and tile actions stay.
  resize(0.45);
  await vi.waitFor(() => expect(shown("Close tile")).toBe(false));
  expect(shownTabs()).toEqual(["Main chat", "diff", "notes", "New tab"]);
  expect(shown("New tile to the right")).toBe(false);
  expect(shown("Maximize tile")).toBe(false);
  expect(shown("New tab")).toBe(true);
  expect(shown("Tile actions")).toBe(true);

  // Then the tail folds, and the active tab takes the last place.
  resize(0.38);
  await vi.waitFor(() => expect(shownTabs()).toEqual(["Main chat", "New tab"]));
  expect(shown("2 more tabs")).toBe(true);

  // At the minimum width only the active tab's icon is left beside +3.
  resize(0.1);
  await vi.waitFor(() => expect(shown("3 more tabs")).toBe(true));
  expect(shownTabs()).toEqual(["New tab"]);
  const activeTab = tile().querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
  expect(activeTab.querySelector("span")!.checkVisibility()).toBe(false);
  const tileRect = tile().getBoundingClientRect();
  expect(tileRect.width).toBeGreaterThanOrEqual(TILE_MIN_WIDTH_PX - 0.5);
  // Nothing in the header is clipped at the minimum.
  expect(
    tile().querySelector('[aria-label="Tile actions"]')!.getBoundingClientRect().right,
  ).toBeLessThanOrEqual(tileRect.right);

  await userEvent.click(screen.getByRole("button", { name: "3 more tabs", exact: true }));
  await userEvent.click(screen.getByRole("menuitem", { name: "diff", exact: true }));
  expect(
    getTileGroups(layout()).find((group) => group.id === "conversation-group")?.activeTabId,
  ).toBe("diff");
  await vi.waitFor(() => expect(shownTabs()).toEqual(["diff"]));
});

it("moves focus to the +N chip when the focused tab folds", async () => {
  await using fixture = await setup(true);
  const { screen } = fixture;
  const { tile, shownTabs, resize } = fourTabTile(fixture);
  resize(0.9);
  await vi.waitFor(() => expect(shownTabs()).toHaveLength(4));
  tile().querySelector<HTMLElement>('[role="tab"][aria-label="diff"]')!.focus();
  resize(0.38);
  await vi.waitFor(() => expect(shownTabs()).toEqual(["Main chat", "New tab"]));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "2 more tabs", exact: true }).element(),
  );
});

it("re-measures a tab whose title changes while truncated, without a resize observer loop", async () => {
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.message);
  window.addEventListener("error", onError);
  using _errors = { [Symbol.dispose]: () => window.removeEventListener("error", onError) };
  await using fixture = await setup(true);
  const { store, threadRef } = fixture;
  const { notes, shownTabs, tabFit, resize } = fourTabTile(fixture);
  const retitle = (title: string) => {
    tabTitles.set(notes, title);
    store.applyTileAction(threadRef, { type: "focus", groupId: "conversation-group" });
  };
  store.applyTileAction(threadRef, {
    type: "activate",
    groupId: "conversation-group",
    tabId: notes,
  });
  resize(0.25);
  await vi.waitFor(() => expect(shownTabs()).toEqual(["notes"]));
  expect(tabFit(notes)).toBe("full");
  retitle("notes with a title long enough to truncate");
  await vi.waitFor(() => expect(tabFit(notes)).toBe("truncated"));
  retitle("n");
  await vi.waitFor(() => expect(tabFit(notes)).toBe("full"));
  expect(errors.filter((message) => message.includes("ResizeObserver"))).toEqual([]);
});

it("keeps the +N chip one width for one- and two-digit counts", async () => {
  await using fixture = await setup(true);
  const { store, threadRef } = fixture;
  const { tile, shown, resize } = fourTabTile(fixture);
  const chipWidth = () => tile().querySelector("[data-fit-chip]")!.getBoundingClientRect().width;
  resize(0.1);
  await vi.waitFor(() => expect(shown("3 more tabs")).toBe(true));
  const single = chipWidth();
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])
    store.applyTileAction(threadRef, {
      type: "new-tab",
      groupId: "conversation-group",
      tabId: newTabId(id),
    });
  await vi.waitFor(() => expect(shown("13 more tabs")).toBe(true));
  expect(chipWidth()).toBe(single);
});

it("refuses a side-by-side split of a tile narrower than two minimum widths", async () => {
  await using fixture = await setup(true);
  const { screen, store, threadRef, layout } = fixture;
  // 630px beside 270px: the right tile has no room to halve.
  store.applyTileAction(threadRef, { type: "resize", splitId: "terminal-split", ratio: 0.7 });
  const control = (groupId: string, label: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-tile-group="${groupId}"] button[aria-label="${label}"]`,
    )!;
  await vi.waitFor(() =>
    expect(control("terminal-group", "New tile to the right").disabled).toBe(true),
  );
  expect(control("conversation-group", "New tile to the right").disabled).toBe(false);
  expect(control("terminal-group", "New tile below").disabled).toBe(false);
  const terminalTile = screen.getByRole("region", { name: "Tile: terminal", exact: true });
  await userEvent.click(terminalTile.getByRole("button", { name: "Tile actions", exact: true }));
  await expect
    .element(screen.getByRole("menuitem", { name: /New tile to the right/ }))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(screen.getByRole("menuitem", { name: /New tile below/ }))
    .not.toHaveAttribute("aria-disabled");
  await userEvent.keyboard("{Escape}");
  store.applyTileAction(threadRef, { type: "focus", groupId: "terminal-group" });
  dispatchMenuAction("workspace.tile.splitRight");
  expect(getTileGroups(layout())).toHaveLength(2);
  dispatchMenuAction("workspace.tile.splitDown");
  expect(getTileGroups(layout())).toHaveLength(3);
});

it("leaves Escape in a maximized terminal even when the shortcut context is stale", async () => {
  await using fixture = await setup(true);
  const { store, threadRef, layout, screen } = fixture;
  store.applyTileAction(threadRef, { type: "maximize", groupId: "terminal-group" });
  const terminal = screen.getByRole("textbox", { name: "Editor terminal:new-terminal" });
  await userEvent.click(terminal);
  await userEvent.keyboard("{Escape}");
  expect(layout().maximizedGroupId).toBe("terminal-group");
});

it("opens layout actions from the title bar and saves the current workspace", async () => {
  await using fixture = await setup();
  const { screen } = fixture;
  const controls = document.querySelector('[aria-label="Title bar controls"]')!;
  expect(controls.querySelector('button[aria-label="Layouts"]')).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Layouts", exact: true }));
  await page.viewport(390, 800);
  await expect
    .element(screen.getByRole("button", { name: "Layouts", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("menu", { name: "Layouts", exact: true }))
    .not.toBeInTheDocument();
  await page.viewport(1100, 800);
  await userEvent.click(screen.getByRole("button", { name: "Layouts", exact: true }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Save layout as…", exact: true }));
  await expect
    .element(screen.getByRole("dialog", { name: "Save layout", exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Tile actions", exact: true }).first());
  await expect
    .element(screen.getByRole("menuitem", { name: "Layouts", exact: true }))
    .not.toBeInTheDocument();
  await screen.rerender(
    <BackgroundThreadContext value={true}>{fixture.workspace}</BackgroundThreadContext>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Layouts", exact: true }))
    .not.toBeInTheDocument();
});

it("runs leader commands from terminal focus and keeps keyboard resize active until Enter", async () => {
  await using fixture = await setup(true, false, true);
  const { screen, layout, selectTab, store, threadRef } = fixture;
  const terminal = screen.getByRole("textbox", { name: "Editor terminal:new-terminal" });
  await userEvent.click(terminal);
  await userEvent.keyboard("{Control>}a{/Control}");
  await userEvent.keyboard("h");
  expect(layout().focusedGroupId).toBe("conversation-group");
  await userEvent.keyboard("{Control>}a{/Control}m");
  expect(layout().maximizedGroupId).toBe("conversation-group");
  await userEvent.keyboard("{Control>}a{/Control}9");
  expect(layout().maximizedGroupId).toBe("conversation-group");
  expect(layout().focusedGroupId).toBe("conversation-group");
  await userEvent.keyboard("{Control>}a{/Control}2");
  expect(layout().maximizedGroupId).toBeNull();
  expect(layout().focusedGroupId).toBe("terminal-group");
  await selectTab("diff");
  await userEvent.click(terminal);
  await userEvent.keyboard("{Control>}a{/Control}1");
  expect(layout().focusedGroupId).toBe("conversation-group");
  expect(getTileGroups(layout())[0]!.activeTabId).toBe("diff");
  await vi.waitFor(() =>
    expect(document.activeElement?.closest('[data-tile-content="diff"]')).not.toBeNull(),
  );
  dispatchMenuAction("workspace.tile.tab.1");
  expect(getTileGroups(layout())[0]!.activeTabId).toBe("conversation");
  await userEvent.click(terminal);
  const before = JSON.stringify(layout().root);
  await userEvent.keyboard("{Control>}a{/Control}r");
  await expect.element(screen.getByRole("status", { name: "Resizing focused tile" })).toBeVisible();
  await userEvent.keyboard("h");
  expect(JSON.stringify(layout().root)).toBe(before);
  await userEvent.keyboard("{Enter}");
  expect(JSON.stringify(layout().root)).not.toBe(before);
  await expect
    .element(screen.getByRole("status", { name: "Resizing focused tile" }))
    .not.toBeInTheDocument();
  const beforeForwardedResize = JSON.stringify(layout().root);
  dispatchMenuAction("workspace.tile.resizeLeft");
  expect(JSON.stringify(layout().root)).not.toBe(beforeForwardedResize);
  const target = terminal.element();
  target.focus();
  const first = new KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  const second = new KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(first);
  target.dispatchEvent(second);
  expect(first.defaultPrevented).toBe(true);
  expect(second.defaultPrevented).toBe(false);

  dispatchMenuAction("workspace.tile.float");
  expect(getTileGroups(layout())[1]?.floating).toBeDefined();
  store.applyTileAction(threadRef, { type: "maximize", groupId: "conversation-group" });
  screen.getByRole("textbox", { name: "Conversation draft" }).element().focus();
  await userEvent.keyboard("{Control>}a{/Control}2");
  expect(layout().focusedGroupId).toBe("terminal-group");
  expect(layout().maximizedGroupId).toBe("conversation-group");
});

it("sends tile keys and menu actions only to the workspace that owns focus, else the one underneath", async () => {
  const keybindings = compileResolvedKeybindingsConfig([
    ...defaultKeybindingsForMode(true),
    { key: "ctrl+alt+shift+arrowdown", command: "workspace.tile.splitDown" },
    { key: "ctrl+alt+enter", command: "workspace.tile.maximize" },
  ]);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1100, 900);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const threadRef = {
    environmentId: EnvironmentId.make("tiles"),
    threadId: ThreadId.make("under"),
  };
  const overlayRef = {
    environmentId: EnvironmentId.make("tiles"),
    threadId: ThreadId.make("over"),
  };
  useRightPanelStore.setState({ byThreadKey: {} });
  const store = useRightPanelStore.getState();
  store.open(threadRef, "files");
  store.openTerminal(overlayRef, "term-1");
  store.applyTileAction(overlayRef, { type: "close-tab", tabId: "conversation" });
  let terminals = 1;
  const noop = () => {};
  function Workspace(props: { threadRef: typeof threadRef; overlay?: boolean }) {
    const panel = useRightPanelStore((state) =>
      selectThreadRightPanelState(state.byThreadKey, props.threadRef),
    );
    return (
      <ThreadTileWorkspace
        threadRef={props.threadRef}
        projectId={null}
        newThread={false}
        header={null}
        runningTerminalIds={[]}
        onCloseTileSurfaces={noop}
        conversation={<textarea aria-label="Thread composer" defaultValue="" />}
        {...(props.overlay ? { terminalsOnly: true, overlay: true } : {})}
        panels={{
          surfaces: panel.surfaces,
          activeSurfaceId: panel.activeSurfaceId,
          environmentId: props.threadRef.environmentId,
          keybindings,
          getShortcutContext: () => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          }),
          pendingSurfaceIds: new Set(),
          previewSessions: {},
          desktopByTabId: {},
          terminalLabelsById: new Map(),
          onActivate: (surface) => store.activateSurface(props.threadRef, surface.id),
          onCloseSurface: noop,
          onCloseOtherSurfaces: noop,
          onCloseSurfacesToRight: noop,
          onCloseAllSurfaces: noop,
          onCopyFilePath: noop,
          onAddBrowser: noop,
          onAddBrowserInProfile: noop,
          onAddTerminal: () => store.openTerminal(props.threadRef, `term-${++terminals}`),
          onAddDiff: noop,
          onAddFiles: noop,
          onAddPullRequest: noop,
          onAddPullRequests: noop,
          onAddDevice: noop,
          browserAvailable: false,
          terminalAvailable: true,
          diffAvailable: false,
          filesAvailable: false,
          pullRequestAvailable: false,
          pullRequestsAvailable: false,
          deviceAvailable: false,
        }}
        renderSurface={(surface) => (
          <textarea aria-label={`Editor ${surface.id}`} defaultValue="" />
        )}
      />
    );
  }
  // Splits stack, since a tile narrower than two minimum widths refuses a side-by-side split.
  const tree = (withOverlay: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", width: 900, height: 800 }}>
      <input aria-label="Outside both" />
      <div role="group" aria-label="Thread" style={{ display: "flex", height: 380 }}>
        <Workspace threadRef={threadRef} />
      </div>
      {withOverlay ? (
        <div role="group" aria-label="Overlay" style={{ display: "flex", height: 380 }}>
          <Workspace threadRef={overlayRef} overlay />
        </div>
      ) : null}
    </div>
  );
  await using screen = await render(tree(true));
  const groups = () => {
    const { byThreadKey } = useRightPanelStore.getState();
    return [
      getTileGroups(selectThreadTileLayout(byThreadKey, threadRef)).length,
      getTileGroups(selectThreadTileLayout(byThreadKey, overlayRef)).length,
    ];
  };
  const splitByKey = () =>
    userEvent.keyboard("{Control>}{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}{/Control}");
  const focus = (name: string) => {
    const element = screen.getByRole("textbox", { name, exact: true }).element();
    (element as HTMLElement).focus();
    expect(document.activeElement).toBe(element);
  };
  // A thread split focuses its new chooser; wait for it so it cannot steal the next focus.
  const threadChooserFocused = () =>
    vi.waitFor(() => expect(document.activeElement?.closest("[data-tile-chooser]")).not.toBeNull());
  expect(groups()).toEqual([2, 1]);

  focus("Editor terminal:term-1");
  await splitByKey();
  expect(groups()).toEqual([2, 2]);
  focus("Editor terminal:term-1");
  dispatchMenuAction("workspace.tile.splitDown");
  expect(groups()).toEqual([2, 3]);
  focus("Editor terminal:term-1");
  const readLayout = (ref: typeof threadRef) =>
    selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, ref);
  const threadBefore = readLayout(threadRef);
  const overlayTiles = getTileGroups(readLayout(overlayRef));
  store.applyTileAction(overlayRef, { type: "focus", groupId: overlayTiles[0]!.id });
  await userEvent.keyboard("{Control>}a{/Control}j");
  expect(readLayout(overlayRef).focusedGroupId).toBe(overlayTiles[1]!.id);
  await userEvent.keyboard("{Control>}a{/Control}3");
  expect(readLayout(overlayRef).focusedGroupId).toBe(overlayTiles[2]!.id);
  expect(readLayout(threadRef)).toEqual(threadBefore);

  // The overlay re-rendered last, so its registrations are the newest.
  focus("Thread composer");
  dispatchMenuAction("workspace.tile.splitDown");
  expect(groups()).toEqual([3, 3]);
  await threadChooserFocused();
  focus("Thread composer");
  await splitByKey();
  expect(groups()).toEqual([4, 3]);
  await threadChooserFocused();

  focus("Outside both");
  dispatchMenuAction("workspace.tile.splitDown");
  expect(groups()).toEqual([5, 3]);
  await threadChooserFocused();
  focus("Outside both");
  await splitByKey();
  expect(groups()).toEqual([6, 3]);

  // A tile menu renders in a portal, yet its workspace still owns the input.
  const openTileMenu = async (workspace: "Thread" | "Overlay") => {
    await userEvent.click(
      screen
        .getByRole("group", { name: workspace, exact: true })
        .getByRole("button", { name: "Tile actions", exact: true })
        .first(),
    );
    await expect.element(screen.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull());
  };
  const closeTileMenu = async () => {
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
  };
  await openTileMenu("Overlay");
  dispatchMenuAction("workspace.tile.splitDown");
  expect(groups()).toEqual([6, 4]);
  await closeTileMenu();
  await openTileMenu("Overlay");
  await splitByKey();
  expect(groups()).toEqual([6, 5]);
  await closeTileMenu();

  // Maximize keeps focus in the thread's menu, unlike a split, which moves it to a new chooser.
  const maximized = () => {
    const { byThreadKey } = useRightPanelStore.getState();
    return [
      selectThreadTileLayout(byThreadKey, threadRef).maximizedGroupId !== null,
      selectThreadTileLayout(byThreadKey, overlayRef).maximizedGroupId !== null,
    ];
  };
  await openTileMenu("Thread");
  dispatchMenuAction("workspace.tile.maximize");
  expect(maximized()).toEqual([true, false]);
  await userEvent.keyboard("{Control>}{Alt>}{Enter}{/Alt}{/Control}");
  expect(maximized()).toEqual([false, false]);
  await closeTileMenu();

  focus("Editor terminal:term-1");
  await screen.rerender(tree(false));
  dispatchMenuAction("workspace.tile.splitDown");
  expect(groups()).toEqual([7, 5]);
});
