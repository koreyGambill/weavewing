import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { WS_METHODS, type ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import "~/index.css";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import {
  selectThreadRightPanelState,
  selectThreadTileLayout,
  useRightPanelStore,
} from "~/rightPanelStore";
import { getRouter } from "~/router";
import { CONVERSATION_TAB_ID, getTileGroups } from "~/threadTileLayout";
import { useDropdownTerminalStore } from "~/dropdownTerminalStore";
import { useToolSidebarStore } from "~/toolSidebarStore";
import {
  ENVIRONMENT_ID,
  answerRpc,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const refOf = (thread: FakeThread) => scopeThreadRef(ENVIRONMENT_ID, thread.id);
// The environment keeps the thread list the first test served, so every test serves the same one.
const here = threadWithHistory("here", 1);
const elsewhere = threadWithHistory("elsewhere", 1);
const THREADS = [here, elsewhere];

async function mountApp(threads: ReadonlyArray<FakeThread>, prepare?: () => void) {
  const stack = new AsyncDisposableStack();
  const initialSize = { width: window.innerWidth, height: window.innerHeight };
  stack.defer(() => page.viewport(initialSize.width, initialSize.height));
  await page.viewport(1280, 800);
  useToolSidebarStore.setState({
    open: false,
    view: "details",
    width: 300,
    pinned: false,
    locked: null,
    maximized: false,
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  prepare?.();
  stack.use(installFakeEnvironment(threads));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  const screen = stack.use(await render(<AppRoot router={router} />, { router: false }));
  stack.defer(() => useDropdownTerminalStore.getState().close());
  await expect.element(screen.getByRole("tab", { name: "Main chat" })).toBeVisible();
  return { stack, screen, router };
}

const groupsOf = (thread: FakeThread) =>
  getTileGroups(selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, refOf(thread)));
const focusedTile = () =>
  document.activeElement?.closest("[data-tile-content]")?.getAttribute("data-tile-content");

/** Counts a thread RPC's requests and holds each open until its caller cancels it. */
function holdRequests(method: string) {
  const started: ThreadId[] = [];
  const open = new Set<symbol>();
  const subscription = answerRpc(method, (input: { readonly threadId: ThreadId }) => {
    const token = Symbol(input.threadId);
    return Effect.suspend(() => {
      started.push(input.threadId);
      open.add(token);
      return Effect.never;
    }).pipe(Effect.ensuring(Effect.sync(() => open.delete(token))));
  });
  return { started, open, [Symbol.dispose]: () => subscription[Symbol.dispose]() };
}

it("promotes the side panel's view by keyboard into a tile beside the chat and focuses it", async () => {
  const thread = here;
  const { stack, screen } = await mountApp(THREADS);
  await using _app = stack;
  const before = document.querySelector("[data-thread-tiling]")!.getBoundingClientRect().width;
  await userEvent.click(screen.getByRole("button", { name: "Toggle side panel", exact: true }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel.getByRole("button", { name: /^View: Details/ })).toHaveFocus();
  expect(document.querySelector("[data-thread-tiling]")!.getBoundingClientRect().width).toBe(
    before,
  );
  const reached: string[] = [];
  for (let step = 0; step < 10; step += 1) {
    await userEvent.tab();
    const label = document.activeElement?.getAttribute("aria-label") ?? "";
    reached.push(label);
    if (label === "Open as tile") break;
  }
  // Header order: Pin, Lock, then Open as tile before Maximize.
  expect(reached.slice(-3)).toEqual(["Pin side panel", "Lock to thread", "Open as tile"]);
  await userEvent.keyboard("{Enter}");

  await expect.element(panel).not.toBeInTheDocument();
  const [chat, beside] = groupsOf(thread);
  expect(chat?.tabs).toEqual([CONVERSATION_TAB_ID]);
  expect(beside?.tabs).toEqual(["view:details"]);
  await expect.element(screen.getByRole("tab", { name: "Details", exact: true })).toBeVisible();
  await vi.waitFor(() => expect(focusedTile()).toBe("view:details"));

  // A pinned panel stays open and can show another view.
  await act(() => {
    useToolSidebarStore.getState().dispatch({ type: "show", view: "status" });
    useToolSidebarStore.getState().dispatch({ type: "pin" });
  });
  await userEvent.click(panel.getByRole("button", { name: "Open as tile" }));
  expect(groupsOf(thread)[1]?.tabs).toEqual(["view:details", "view:status"]);
  expect(useToolSidebarStore.getState().open).toBe(true);
  await vi.waitFor(() => expect(focusedTile()).toBe("view:status"));
});

it("keeps a view promoted from a panel locked elsewhere on that thread, then moves it back locked", async () => {
  const { stack, screen } = await mountApp(THREADS);
  await using _app = stack;
  await act(() => {
    useToolSidebarStore.getState().dispatch({ type: "show", view: "links" });
    useToolSidebarStore.getState().dispatch({ type: "lock", thread: refOf(elsewhere) });
  });
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await vi.waitFor(() =>
    expect(document.querySelector("#side-area")?.textContent).toContain(
      `Locked to ${elsewhere.title}`,
    ),
  );
  await userEvent.click(panel.getByRole("button", { name: "Open as tile" }));
  await expect.element(panel).not.toBeInTheDocument();
  const tabName = `Links · ${elsewhere.title}`;
  await expect.element(screen.getByRole("tab", { name: tabName, exact: true })).toBeVisible();
  const tile = screen.getByRole("region", { name: `Tile: ${tabName}`, exact: true });
  await expect
    .element(page.getByText(`Locked to ${elsewhere.title}`, { exact: false }).first())
    .toBeVisible();

  await userEvent.click(tile.getByRole("button", { name: "Tile actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Move to side panel" }));
  await expect.element(panel).toBeVisible();
  expect(useToolSidebarStore.getState()).toMatchObject({
    view: "links",
    locked: refOf(elsewhere),
  });
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refOf(here)).surfaces,
  ).toEqual([]);
  await expect.element(panel.getByRole("button", { name: /^View: Links/ })).toHaveFocus();
});

it("sends nothing for hidden view tabs and cancels a view's requests when its tab hides", async () => {
  const thread = here;
  using todos = holdRequests(WS_METHODS.threadListRead);
  using artifacts = holdRequests(WS_METHODS.threadArtifactList);
  const { stack, screen } = await mountApp(THREADS, () => {
    const store = useRightPanelStore.getState();
    store.openView(refOf(thread), "todos", null, "tile-2");
    store.openView(refOf(thread), "artifacts", null, "tile-2");
    store.openView(refOf(thread), "related", null, "tile-2");
  });
  await using _app = stack;
  const relatedTab = screen.getByRole("tab", { name: "Related", exact: true });
  await expect.element(relatedTab).toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByRole("region", { name: "Related" })).toBeVisible();
  expect(todos.started).toEqual([]);
  expect(artifacts.started).toEqual([]);

  await userEvent.click(screen.getByRole("tab", { name: "Todos", exact: true }));
  await vi.waitFor(() => expect(todos.started).toEqual([thread.id]));
  expect(todos.open.size).toBe(1);
  await userEvent.click(relatedTab);
  await vi.waitFor(() => expect(todos.open.size).toBe(0));
  expect(artifacts.started.filter((id) => id !== thread.id)).toEqual([]);
});

it("shows a view in a narrow tile compact, with Open full size maximizing the tile", async () => {
  const thread = here;
  const { stack, screen } = await mountApp(THREADS, () => {
    const store = useRightPanelStore.getState();
    store.openView(refOf(thread), "related", null, "tile-2");
  });
  await using _app = stack;
  const split = selectThreadTileLayout(
    useRightPanelStore.getState().byThreadKey,
    refOf(thread),
  ).root;
  expect(split.kind).toBe("split");
  await act(() =>
    useRightPanelStore
      .getState()
      .applyTileAction(refOf(thread), { type: "resize", splitId: split.id, ratio: 0.82 }),
  );
  const openFull = screen.getByRole("button", { name: "Open full size" });
  await expect.element(openFull).toBeVisible();
  await userEvent.click(openFull);
  await vi.waitFor(() =>
    expect(
      selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, refOf(thread))
        .maximizedGroupId,
    ).toBe(groupsOf(thread)[1]?.id),
  );
  await expect.element(openFull).not.toBeInTheDocument();
});

it("drops the side panel's view on a tile edge to split it, and cancels a drop elsewhere", async () => {
  const thread = here;
  const { stack, screen } = await mountApp(THREADS);
  await using _app = stack;
  await act(() => useToolSidebarStore.getState().dispatch({ type: "show", view: "related" }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  const grip = panel.element().querySelector<HTMLElement>("[data-view-drag-grip]")!;
  expect(grip).not.toBeNull();

  // Dropping on the thread list changes nothing.
  await userEvent.dragAndDrop(grip, screen.getByRole("navigation", { name: "Threads" }), {
    force: true,
  });
  expect(groupsOf(thread).flatMap((group) => group.tabs)).toEqual([CONVERSATION_TAB_ID]);
  expect(useToolSidebarStore.getState().open).toBe(true);

  const chat = screen.getByRole("region", { name: "Tile: Main chat", exact: true });
  const box = chat.element().getBoundingClientRect();
  await userEvent.dragAndDrop(grip, chat, {
    targetPosition: { x: 12, y: box.height / 2 },
    force: true,
  });
  await vi.waitFor(() =>
    expect(groupsOf(thread).map((group) => group.tabs)).toEqual([
      ["view:related"],
      [CONVERSATION_TAB_ID],
    ]),
  );
  await expect.element(panel).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedTile()).toBe("view:related"));
});

it("offers no split of a tile too narrow to divide when a view is dragged onto its edge", async () => {
  const thread = here;
  const { stack, screen } = await mountApp(THREADS, () => {
    useRightPanelStore.getState().openView(refOf(thread), "todos", null, "tile-2");
  });
  await using _app = stack;
  const split = selectThreadTileLayout(
    useRightPanelStore.getState().byThreadKey,
    refOf(thread),
  ).root;
  await act(() =>
    useRightPanelStore
      .getState()
      .applyTileAction(refOf(thread), { type: "resize", splitId: split.id, ratio: 0.25 }),
  );
  await act(() => useToolSidebarStore.getState().dispatch({ type: "show", view: "related" }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  const grip = panel.element().querySelector<HTMLElement>("[data-view-drag-grip]")!;
  const chat = screen.getByRole("region", { name: "Tile: Main chat", exact: true });
  const box = chat.element().getBoundingClientRect();
  await userEvent.dragAndDrop(grip, chat, {
    targetPosition: { x: 12, y: box.height / 2 },
    force: true,
  });
  expect(groupsOf(thread).map((group) => group.tabs)).toEqual([
    [CONVERSATION_TAB_ID],
    ["view:todos"],
  ]);
  expect(useToolSidebarStore.getState().open).toBe(true);
});
