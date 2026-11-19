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
import { getTileGroups, isNewTab, newTabId } from "../../threadTileLayout";
import { ThreadTileWorkspace } from "./ThreadTileWorkspace";

vi.mock("../SurfaceTabContent", () => ({
  SurfaceIcon: () => null,
  surfaceTitle: (surface: { kind: string }) => surface.kind,
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
    if (tab && !tab.checkVisibility()) {
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
  const newTileRight = async () => {
    await userEvent.click(
      screen.getByRole("button", { name: "Tile actions", exact: true }).first(),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /New tile to the right/ }));
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
    newTileRight,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

it("keeps conversation and editor contents mounted through grouping, splitting and maximizing", async () => {
  await using fixture = await setup();
  const { screen, store, threadRef, layout, selectTab, newTileRight } = fixture;
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
  await newTileRight();
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
  await newTileRight();
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
  const { screen, store, threadRef, layout, newTileRight } = fixture;
  await newTileRight();
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
  await newTileRight();
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
  const { screen, layout } = fixture;
  const terminal = screen.getByRole("textbox", { name: "Editor terminal:new-terminal" });
  await userEvent.click(terminal);
  await userEvent.keyboard("{Control>}a{/Control}");
  await userEvent.keyboard("h");
  expect(layout().focusedGroupId).toBe("conversation-group");
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
});

it("sends tile keys and menu actions only to the workspace that owns focus, else the one underneath", async () => {
  const keybindings = compileResolvedKeybindingsConfig(defaultKeybindingsForMode(false));
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
    userEvent.keyboard("{Control>}{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}{/Control}");
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
  dispatchMenuAction("workspace.tile.splitRight");
  expect(groups()).toEqual([2, 3]);

  // The overlay re-rendered last, so its registrations are the newest.
  focus("Thread composer");
  dispatchMenuAction("workspace.tile.splitRight");
  expect(groups()).toEqual([3, 3]);
  await threadChooserFocused();
  focus("Thread composer");
  await splitByKey();
  expect(groups()).toEqual([4, 3]);
  await threadChooserFocused();

  focus("Outside both");
  dispatchMenuAction("workspace.tile.splitRight");
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
  dispatchMenuAction("workspace.tile.splitRight");
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
  dispatchMenuAction("workspace.tile.splitRight");
  expect(groups()).toEqual([7, 5]);
});
