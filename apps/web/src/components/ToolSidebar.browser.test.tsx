import { createMemoryHistory } from "@tanstack/react-router";
import {
  MessageId,
  ThreadId,
  WS_METHODS,
  type ThreadWorkspace,
  type WaitingItemSummary,
} from "@t3tools/contracts";
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
import { getRouter } from "~/router";
import { useDropdownTerminalStore } from "~/dropdownTerminalStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { threadListRead } from "~/state/threadWorkspace";
import { openInbox } from "./inbox/openInbox";
import { useThreadContextSidebarStore } from "~/threadContextSidebarStore";
import { useToolSidebarStore } from "~/toolSidebarStore";
import { SIDE_AREA_SETTLE_MS } from "./ToolSidebar";
import {
  ENVIRONMENT_ID,
  acknowledgePendingCommand,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../test/render";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "~/rightPanelStore";
import { readSelectedThreadRef } from "~/threadContextSidebar";
import { ThreadReviewsButton } from "./reviews/ThreadReviewsButton";
import { WaitingItemsList } from "./waiting/WaitingItemsList";
import { groupWaitingItems } from "./waiting/waitingStrip.logic";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

// A direct page load with no history replaces itself with the default place, here the "direct" thread.
vi.mock(import("~/hooks/useScratchProject"), async (original) => {
  const actual = await original();
  const { useNavigate } = await import("@tanstack/react-router");
  const { ENVIRONMENT_ID: environmentId, PROJECT_ID } = await import("../../test/fakeEnvironment");
  return {
    ...actual,
    useScratchProject: () => {
      const navigate = useNavigate();
      return {
        ...actual.useScratchProject(),
        defaultPlace: () => ({
          kind: "project" as const,
          projectRef: { environmentId, projectId: PROJECT_ID },
          unavailable: null,
        }),
        startDefaultPlace: async (options?: { readonly replace?: boolean }) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: "direct" },
            replace: options?.replace ?? false,
          });
          return true;
        },
      };
    },
  };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

async function mountApp(
  threads: ReadonlyArray<FakeThread>,
  width: number,
  path?: string,
  restore?: () => Promise<void>,
) {
  const stack = new AsyncDisposableStack();
  const initialSize = { width: window.innerWidth, height: window.innerHeight };
  stack.defer(() => page.viewport(initialSize.width, initialSize.height));
  await page.viewport(width, 800);
  useToolSidebarStore.setState(useToolSidebarStore.getInitialState());
  useThreadContextSidebarStore.setState(useThreadContextSidebarStore.getInitialState());
  await restore?.();
  useRightPanelStore.setState({ byThreadKey: {} });
  stack.use(installFakeEnvironment(threads, { messageBookmarks: true }));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [path ?? `/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  const screen = stack.use(await render(<AppRoot router={router} />, { router: false }));
  stack.defer(() => useDropdownTerminalStore.getState().close());
  if (path === undefined) {
    await expect.element(screen.getByRole("tab", { name: "Main chat" })).toBeVisible();
  }
  return { stack, screen, router };
}

// The thread views shortcut, mod+alt+i, with the modifier the app reads on this platform.
const THREAD_VIEWS_SHORTCUT = isMacPlatform(navigator.platform)
  ? "{Meta>}{Alt>}i{/Alt}{/Meta}"
  : "{Control>}{Alt>}i{/Alt}{/Control}";

function widthOf(selector: string) {
  const element = document.querySelector(selector);
  expect(element).not.toBeNull();
  return element!.getBoundingClientRect().width;
}

it("shows the menu's thread in Checklist, locked, while a side chat of it is focused", async () => {
  const main = threadWithHistory("menu-main", 1);
  const side = {
    ...threadWithHistory("menu-side", 1),
    sideChatOf: main.id,
    olderSettled: true as const,
  };
  const { stack, screen } = await mountApp([main, side], 1280);
  await using _app = stack;
  const mainRef = scopeThreadRef(ENVIRONMENT_ID, main.id);
  await act(() => useRightPanelStore.getState().openSideChat(mainRef, side.id));
  await expect
    .element(screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true }))
    .toBeVisible();
  expect(readSelectedThreadRef(mainRef)).toEqual(scopeThreadRef(ENVIRONMENT_ID, side.id));
  // From the keyboard: a pointer click on the same spot as an earlier test's reads as a double-click.
  screen
    .getByRole("button", { name: `Thread actions for ${main.title}` })
    .element()
    .focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(page.getByRole("menuitem", { name: "Checklist" }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel.getByText(main.title, { exact: true })).toBeVisible();
  expect(useToolSidebarStore.getState()).toMatchObject({
    open: true,
    view: "checklist",
    locked: mainRef,
  });
});

it("covers the chat without changing the chat's or the thread list's width", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("cover", 2)], 1280);
  await using _app = stack;
  const widths = () => ({
    main: widthOf("main"),
    chat: widthOf("[data-thread-tiling]"),
    threads: widthOf("[data-app-sidebar]"),
  });
  const before = widths();
  await userEvent.click(
    screen
      .getByRole("toolbar", { name: "Side panel views" })
      .getByRole("button", { name: "Details", exact: true }),
  );
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  expect(panel.element().getBoundingClientRect().width).toBe(300);
  expect(widths()).toEqual(before);
  await act(() => useToolSidebarStore.getState().dispatch({ type: "resize", width: 640 }));
  await vi.waitFor(() => expect(panel.element().getBoundingClientRect().width).toBe(640));
  expect(widths()).toEqual(before);
  await userEvent.click(panel.getByRole("button", { name: "Maximize side panel" }));
  await expect
    .element(panel.getByRole("button", { name: "Restore side panel size" }))
    .toBeVisible();
  expect(widthOf("[data-app-sidebar]")).toBe(before.threads);
  await expect.element(screen.getByRole("navigation", { name: "Threads" })).toBeVisible();
  await userEvent.click(panel.getByRole("button", { name: "Close side panel" }));
  await expect.element(panel).not.toBeInTheDocument();
  expect(widths()).toEqual(before);
});

it("leaves the full composer reachable and sends with Enter while pinned", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("send-with-panel", 1)], 1280);
  await using _app = stack;
  const toolbar = screen.getByRole("toolbar", { name: "Side panel views" });
  const waiting = toolbar.getByRole("button", { name: "Waiting on you", exact: true });
  await userEvent.click(waiting);
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  const composer = document.querySelector("[data-chat-composer-stack]")!;
  const before = composer.getBoundingClientRect();
  await expect.element(waiting).toHaveAttribute("aria-pressed", "true");
  await vi.waitFor(() => {
    const bounds = panel.element().getBoundingClientRect();
    expect(bounds.left).toBeLessThan(before.right);
    expect(bounds.bottom).toBeLessThan(before.top);
  });
  await userEvent.click(panel.getByRole("button", { name: "Pin side panel" }));
  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("thread.visit"),
  );
  await acknowledgePendingCommand();
  await userEvent.click(page.getByTestId("composer-editor"));
  await expect.element(panel).toBeVisible();
  await userEvent.keyboard("Check the report{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );
  await expect.element(panel).toBeVisible();
});

it("gives the thread list the whole left sidebar and opens thread views on the right", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("no-rail", 1)], 1280);
  await using _app = stack;
  expect(document.querySelector('nav[aria-label="Sidebar views"]')).toBeNull();
  const sidebar = document.querySelector('[data-app-sidebar] [data-sidebar="sidebar"]');
  const list = document.querySelector('[data-app-sidebar] [data-slot="scroll-area-viewport"]');
  expect(sidebar).not.toBeNull();
  expect(list).not.toBeNull();
  // The rail took 44 px beside the list; only the sidebar's border may remain.
  expect(list!.getBoundingClientRect().width).toBeGreaterThanOrEqual(
    sidebar!.getBoundingClientRect().width - 2,
  );
  await act(() => useToolSidebarStore.setState({ view: "status", threadView: "links" }));
  await userEvent.keyboard(THREAD_VIEWS_SHORTCUT);
  await expect.element(screen.getByRole("complementary", { name: "Side panel" })).toBeVisible();
  expect(useToolSidebarStore.getState()).toMatchObject({ open: true, view: "links" });
  await userEvent.keyboard(THREAD_VIEWS_SHORTCUT);
  await expect
    .element(screen.getByRole("complementary", { name: "Side panel" }))
    .not.toBeInTheDocument();
});

it("moves focus into the side panel, tabs through it and out while pinned, and returns focus on Escape", async () => {
  const thread = threadWithHistory("focus", 1);
  const { stack, screen } = await mountApp([thread], 1280);
  await using _app = stack;
  const icon = screen
    .getByRole("toolbar", { name: "Side panel views" })
    .getByRole("button", { name: "Links", exact: true });
  icon.element().focus();
  await userEvent.keyboard("{Enter}");
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel.getByRole("heading", { name: "Links", level: 2 })).toHaveFocus();
  await expect.element(icon).toHaveAttribute("aria-pressed", "true");

  const reached: string[] = [];
  const inPanel = () => document.activeElement?.closest("#side-area") !== null;
  for (let step = 0; step < 30 && inPanel(); step += 1) {
    await userEvent.tab();
    if (inPanel()) reached.push(document.activeElement?.getAttribute("aria-label") ?? "");
    if (document.activeElement?.getAttribute("aria-label") === "Pin side panel") {
      await userEvent.keyboard("{Enter}");
    }
  }
  expect(reached).toEqual(
    expect.arrayContaining(["Pin side panel", "Lock to thread", "Maximize side panel"]),
  );
  expect(inPanel()).toBe(false);
  expect(useToolSidebarStore.getState()).toMatchObject({ open: true, pinned: true });
  await userEvent.keyboard("{Escape}");
  expect(useToolSidebarStore.getState().open).toBe(true);

  await userEvent.tab({ shift: true });
  for (let step = 0; step < 30 && !inPanel(); step += 1) await userEvent.tab({ shift: true });
  expect(inPanel()).toBe(true);
  // A keyboard-focused control's tooltip is the topmost layer, so it takes the first Escape.
  for (let press = 0; press < 2 && useToolSidebarStore.getState().open; press += 1) {
    await userEvent.keyboard("{Escape}");
  }
  await expect.element(panel).not.toBeInTheDocument();
  await expect.element(icon).toHaveFocus();
});

it("lets a filter clear on Escape first, then closes the panel on the next Escape", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("escape", 1)], 1280);
  await using _app = stack;
  await act(() => useToolSidebarStore.getState().dispatch({ type: "show", view: "links" }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  const filter = panel.getByRole("searchbox", { name: "Filter links" });
  await userEvent.click(filter);
  await userEvent.keyboard("docs");
  await expect.element(filter).toHaveValue("docs");
  await userEvent.keyboard("{Escape}");
  await expect.element(filter).toHaveValue("");
  expect(useToolSidebarStore.getState().open).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(panel).not.toBeInTheDocument();
});

it("hides the drop-down terminal under a full-width sheet and closes the sheet when the terminal opens", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("sheet", 1)], 390);
  await using _app = stack;
  await act(() => useDropdownTerminalStore.getState().toggle());
  const terminal = page.getByRole("region", { name: "Drop-down terminal" });
  await expect.element(terminal).toBeVisible();
  const terminalElement = terminal.element() as HTMLElement;
  await userEvent.click(screen.getByRole("button", { name: "Toggle side panel", exact: true }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  const close = panel.getByRole("button", { name: "Close side panel" });
  await expect.element(close).toBeVisible();
  await vi.waitFor(() => expect(getComputedStyle(terminalElement).visibility).toBe("hidden"));
  expect(terminalElement.inert).toBe(true);
  const box = close.element().getBoundingClientRect();
  expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(
    close.element().closest("button") ?? close.element(),
  );
  await userEvent.click(close);
  await expect.element(panel).not.toBeInTheDocument();
  await expect.element(terminal).toBeVisible();

  await act(() => useDropdownTerminalStore.getState().close());
  await act(() => useToolSidebarStore.getState().dispatch({ type: "show", view: "links" }));
  await expect.element(panel).toBeVisible();
  await act(() => useDropdownTerminalStore.getState().toggle());
  await expect.element(terminal).toBeVisible();
  expect(useToolSidebarStore.getState().open).toBe(false);
});

it("restores a maximized side panel when the drop-down terminal opens beside it", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("beside", 1)], 1280);
  await using _app = stack;
  await act(() => {
    useToolSidebarStore.getState().dispatch({ type: "show", view: "links" });
    useToolSidebarStore.getState().dispatch({ type: "maximize" });
  });
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect
    .element(panel.getByRole("button", { name: "Restore side panel size" }))
    .toBeVisible();
  await act(() => useDropdownTerminalStore.getState().toggle());
  const terminal = page.getByRole("region", { name: "Drop-down terminal" });
  await expect.element(terminal).toBeVisible();
  await expect.element(panel.getByRole("button", { name: "Maximize side panel" })).toBeVisible();
  await vi.waitFor(() =>
    expect(terminal.element().getBoundingClientRect().right).toBe(
      panel.element().getBoundingClientRect().left,
    ),
  );
  expect(panel.element().getBoundingClientRect().width).toBe(300);
});

it("closes an unpinned side panel on a click outside it", async () => {
  const thread = threadWithHistory("outside", 1);
  const { stack, screen } = await mountApp([thread], 1280);
  await using _app = stack;
  await userEvent.click(
    screen
      .getByRole("toolbar", { name: "Side panel views" })
      .getByRole("button", { name: "Details", exact: true }),
  );
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  await userEvent.click(screen.getByRole("textbox", { name: `Message ${thread.title}` }));
  await expect.element(panel).not.toBeInTheDocument();
});

it("loads Checklist only for the last of ten quick switches, showing the view at once", async () => {
  const threads = Array.from({ length: 10 }, (_, index) => threadWithHistory(`walk-${index}`, 1));
  const { stack, screen, router } = await mountApp(threads, 1280);
  await using _app = stack;
  const started: string[] = [];
  const interrupted: string[] = [];
  const inFlight = new Map<ThreadId, number>();
  let maxThreadsInFlight = 0;
  const hold = (method: string) => (input: { readonly threadId: ThreadId }) =>
    Effect.suspend(() => {
      started.push(`${method} ${input.threadId}`);
      inFlight.set(input.threadId, (inFlight.get(input.threadId) ?? 0) + 1);
      maxThreadsInFlight = Math.max(maxThreadsInFlight, inFlight.size);
      return Effect.never;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          interrupted.push(`${method} ${input.threadId}`);
          const left = (inFlight.get(input.threadId) ?? 1) - 1;
          if (left === 0) inFlight.delete(input.threadId);
          else inFlight.set(input.threadId, left);
        }),
      ),
    );
  using _list = answerRpc(WS_METHODS.threadListRead, hold("listRead"));
  using _artifacts = answerRpc(WS_METHODS.threadArtifactList, hold("artifactList"));
  await act(() => {
    useToolSidebarStore.getState().dispatch({ type: "show", view: "checklist" });
    useToolSidebarStore.getState().dispatch({ type: "pin" });
  });
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  await vi.waitFor(() =>
    expect(started.toSorted()).toEqual([
      `artifactList ${threads[0]!.id}`,
      `listRead ${threads[0]!.id}`,
    ]),
  );
  started.length = 0;
  using _timers = fakeTimers();
  for (const thread of threads.slice(1)) {
    await act(() => router.navigate({ to: `/${ENVIRONMENT_ID}/${thread.id}` }));
  }
  expect(started).toEqual([]);
  await vi.waitFor(() => expect(inFlight.size).toBe(0));
  await expect.element(panel.getByRole("region", { name: "Checklist" })).toBeVisible();
  expect(panel.element().querySelector('[data-slot="skeleton"]')).toBeNull();
  interrupted.length = 0;
  const last = threads.at(-1)!.id;
  const lastList = threadListRead({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: last, all: true },
  });
  // The rest ends on a timer outside any act scope, as it does in the app. The final query must be
  // subscribed in that same task: an unsubscribed node is collected by the registry's next task,
  // which interrupts the request it just started.
  vi.advanceTimersByTime(SIDE_AREA_SETTLE_MS);
  expect(appAtomRegistry.getNodes().get(lastList)?.listeners.size ?? 0).toBeGreaterThan(0);
  await vi.waitFor(() =>
    expect(started.toSorted()).toEqual([`artifactList ${last}`, `listRead ${last}`]),
  );
  await act(async () => {});
  // The final thread's pair is sent once and kept, not sent, interrupted and sent again.
  expect(started.toSorted()).toEqual([`artifactList ${last}`, `listRead ${last}`]);
  expect(interrupted).toEqual([]);
  expect(maxThreadsInFlight).toBe(1);
  expect(useToolSidebarStore.getState().open).toBe(true);
});

it("opens a global view as a page from the side panel and hands it back", async () => {
  const thread = threadWithHistory("page", 1);
  const { stack, screen, router } = await mountApp([thread], 1280);
  await using _app = stack;
  const threadPath = `/${ENVIRONMENT_ID}/${thread.id}`;
  await act(() => {
    const { dispatch } = useToolSidebarStore.getState();
    dispatch({ type: "show", view: "details" });
    dispatch({ type: "maximize" });
    dispatch({ type: "show", view: "calendar" });
  });
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toHaveAttribute("data-side-area", "maximized");
  await expect
    .element(panel.getByRole("button", { name: "Restore side panel size" }))
    .toBeVisible();
  await userEvent.click(panel.getByRole("button", { name: "Open Calendar as a page" }));

  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/view/calendar"));
  await expect.element(screen.getByRole("heading", { name: "Calendar", level: 1 })).toHaveFocus();
  await expect.element(panel).not.toBeInTheDocument();
  await expect.element(screen.getByRole("navigation", { name: "Threads" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Open in side panel" }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(threadPath));
  await expect.element(panel.getByRole("heading", { name: "Calendar", level: 2 })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(panel).not.toBeInTheDocument();
  await expect
    .element(
      screen
        .getByRole("toolbar", { name: "Side panel views" })
        .getByRole("button", { name: "Calendar", exact: true }),
    )
    .toHaveFocus();

  await act(() => router.navigate({ to: "/view/$viewId", params: { viewId: "status" } }));
  await expect.element(screen.getByRole("heading", { name: "Status", level: 1 })).toHaveFocus();
  await act(() => router.history.back());
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(threadPath));
});

it.each([1280, 390])(
  "hands a directly loaded page's view to the side panel on its default place at %i px",
  async (width) => {
    const thread = threadWithHistory("direct", 1);
    const { stack, screen, router } = await mountApp([thread], width, "/view/calendar");
    await using _app = stack;
    await expect.element(screen.getByRole("heading", { name: "Calendar", level: 1 })).toHaveFocus();
    expect(router.history.canGoBack()).toBe(false);
    screen.getByRole("button", { name: "Open in side panel" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(router.state.resolvedLocation?.pathname).toBe(`/${ENVIRONMENT_ID}/${thread.id}`),
    );
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    const picker =
      width === 1280
        ? panel.getByRole("heading", { name: "Calendar", level: 2 })
        : panel.getByRole("button", { name: /^View: Calendar/ });
    // The composer mounts and asks for focus; at 390 px it sits inert under the panel's sheet.
    await expect
      .element(screen.getByRole("textbox", { name: /^Message/, includeHidden: true }))
      .toBeInTheDocument();
    await expect.element(picker).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(panel).not.toBeInTheDocument();
    await expect
      .element(
        width === 1280
          ? screen
              .getByRole("toolbar", { name: "Side panel views" })
              .getByRole("button", { name: "Calendar", exact: true })
          : screen.getByRole("button", { name: "Toggle side panel", exact: true }),
      )
      .toHaveFocus();
  },
);

it("closes a page view's panel on the first Escape after a thread view was maximized", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("escape", 1)], 1280);
  await using _app = stack;
  await act(() => {
    const { dispatch } = useToolSidebarStore.getState();
    dispatch({ type: "show", view: "checklist" });
    dispatch({ type: "maximize" });
    dispatch({ type: "show", view: "calendar" });
  });
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toHaveAttribute("data-side-area", "maximized");
  panel.getByRole("heading", { name: "Calendar", level: 2 }).element().focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(panel).not.toBeInTheDocument();
});

it("keeps a page-only view out of the side panel's picker", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("picker", 1)], 1280);
  await using _app = stack;
  await act(() => useToolSidebarStore.getState().dispatch({ type: "show", view: "calendar" }));
  await userEvent.click(screen.getByRole("button", { name: "Side panel settings" }));
  await expect.element(page.getByRole("menuitemradio", { name: "Status" })).toBeVisible();
  expect(page.getByRole("menuitemradio", { name: "Pull requests" }).elements()).toHaveLength(0);
  expect(
    page.getByRole("menuitem", { name: /^(Hide|Show) Pull requests$/ }).elements(),
  ).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
});

it("shows a way back for a view id with no page", async () => {
  const thread = threadWithHistory("missing", 1);
  const { stack, screen, router } = await mountApp([thread], 1280);
  await using _app = stack;
  await act(() => router.navigate({ to: "/view/$viewId", params: { viewId: "checklist" } }));
  await expect.element(screen.getByRole("heading", { name: "View not found" })).toHaveFocus();
  await expect.element(screen.getByText("Checklist has no page")).toBeVisible();
  await act(() => router.navigate({ to: "/view/$viewId", params: { viewId: "no-such-view" } }));
  await expect.element(screen.getByText("There is no view here")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Return to previous page" }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/view/checklist"));
  await act(() => router.navigate({ to: "/view/$viewId", params: { viewId: "pull-requests" } }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/pull-requests"));
});

it("shows the thread a view was opened for when its destination focuses another thread", async () => {
  const [alpha, beta] = [threadWithHistory("target-alpha", 1), threadWithHistory("target-beta", 1)];
  const { stack, router } = await mountApp([alpha, beta], 1280);
  await using _app = stack;
  const betaRef = scopeThreadRef(ENVIRONMENT_ID, beta.id);
  // Beta's tiles focus a side chat of Alpha, so arriving there selects Alpha.
  await act(() => useRightPanelStore.getState().openSideChat(betaRef, alpha.id));
  await act(async () => {
    useThreadContextSidebarStore
      .getState()
      .show("artifacts", { thread: betaRef, artifactId: "review", arriving: true });
    await router.navigate({ to: `/${ENVIRONMENT_ID}/${beta.id}` });
  });
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel.getByText(beta.title, { exact: true })).toBeVisible();
  expect(useToolSidebarStore.getState()).toMatchObject({
    open: true,
    view: "artifacts",
    locked: betaRef,
    arrival: null,
  });
});

it("keeps a view opened for another thread open when the navigation to it arrives", async () => {
  const [here, there] = [threadWithHistory("review-here", 1), threadWithHistory("review-there", 1)];
  const { stack, router } = await mountApp([here, there], 1280);
  await using _app = stack;
  const thereRef = scopeThreadRef(ENVIRONMENT_ID, there.id);
  // What a review reminder does from another thread: open the view, then navigate there.
  await act(async () => {
    useThreadContextSidebarStore
      .getState()
      .show("artifacts", { thread: thereRef, artifactId: "review", arriving: true });
    await router.navigate({ to: `/${ENVIRONMENT_ID}/${there.id}` });
  });
  await expect.element(page.getByRole("complementary", { name: "Side panel" })).toBeVisible();
  expect(useToolSidebarStore.getState()).toMatchObject({
    open: true,
    view: "artifacts",
    arrival: null,
  });
  await act(() => router.navigate({ to: `/${ENVIRONMENT_ID}/${here.id}` }));
  await expect
    .element(page.getByRole("complementary", { name: "Side panel" }))
    .not.toBeInTheDocument();
});

const waitingThread = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("waiting-host"));
const waitingTask: ReadonlyArray<WaitingItemSummary> = [
  { kind: "task", ref: "T1", key: "task-1", title: "Rotate the webhook secret", state: "open" },
];
const emptyWorkspace: ThreadWorkspace = {
  threadId: waitingThread.threadId,
  revision: 1,
  items: [],
  artifacts: [],
  questions: [],
  summaryNotes: "",
  childPreamble: "",
  updatedAt: null,
};

it.each([
  ["a waiting task", { name: "T1: Rotate the webhook secret" }, "checklist"],
  ["the composer's Artifacts button", { name: "Artifacts", exact: true }, "artifacts"],
] as const)(
  "keeps an unpinned panel open when %s outside it opens a view",
  async (_caller, button, view) => {
    const { stack, screen } = await mountApp([threadWithHistory("outside-open", 1)], 1280);
    await using _app = stack;
    // A second root outside the panel, as the waiting strip and the composer are.
    await using outside = await render(
      <div style={{ position: "fixed", left: 280, top: 120, width: 600, zIndex: 50 }}>
        <WaitingItemsList
          threadRef={waitingThread}
          groups={groupWaitingItems(waitingTask)}
          workspace={emptyWorkspace}
          unlisted={0}
          hasQuestions={false}
        />
        <ThreadReviewsButton threadRef={waitingThread} />
      </div>,
    );
    await act(() => useToolSidebarStore.getState().dispatch({ type: "show", view: "links" }));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    await expect.element(panel).toBeVisible();
    await userEvent.click(outside.getByRole("button", button));
    await expect.element(panel.getByRole("region", { name: viewTitle(view) })).toBeVisible();
    expect(useToolSidebarStore.getState()).toMatchObject({ open: true, view });
  },
);

function viewTitle(view: "checklist" | "artifacts") {
  return view === "checklist" ? "Checklist" : "Artifacts";
}

it("closes the thread drawer and focuses the panel when the shortcut opens it on a phone", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("phone-drawer", 1)], 390);
  await using _app = stack;
  await userEvent.click(screen.getByRole("button", { name: /^Toggle main sidebar/ }));
  const drawer = page.getByRole("navigation", { name: "Threads" });
  await expect.element(drawer).toBeVisible();
  await userEvent.keyboard(THREAD_VIEWS_SHORTCUT);
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  await expect.element(drawer).not.toBeInTheDocument();
  await expect
    .element(panel.getByRole("button", { name: /^View: .*Choose a view$/ }))
    .toHaveFocus();
});

it.each([false, true])(
  "closes the phone drawer and focuses Inbox with an existing panel: %s",
  async (existingPanel) => {
    const { stack, screen } = await mountApp([threadWithHistory("phone-inbox", 1)], 390);
    await using _app = stack;
    if (existingPanel) {
      await act(() => {
        const panel = useToolSidebarStore.getState();
        panel.dispatch({ type: "show", view: "activity" });
        panel.dispatch({ type: "pin" });
      });
    }
    await userEvent.click(screen.getByRole("button", { name: /^Toggle main sidebar/ }));
    const drawer = page.getByRole("navigation", { name: "Threads" });
    await expect.element(drawer).toBeVisible();
    // As the thread list's Waiting on you row or a notification does.
    await act(() => openInbox());
    expect(document.querySelector('[data-mobile="true"][data-open]')).toBeNull();
    await expect.element(page.getByRole("complementary", { name: "Side panel" })).toBeVisible();
    await expect.element(drawer).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^View: Inbox/ })).toHaveFocus();
  },
);

it("counts Checklist and flags Links on the strip from held data only", async () => {
  const [held, other] = [threadWithHistory("count-held", 1), threadWithHistory("count-other", 1)];
  const requested: string[] = [];
  const item = (id: string, linkStates?: ThreadWorkspace["items"][number]["linkStates"]) => ({
    id,
    text: id,
    state: "open" as const,
    owner: "agent" as const,
    createdAt: "2026-11-13T00:00:00.000Z",
    doneAt: null,
    details: "",
    parentId: null,
    links: [],
    ...(linkStates ? { linkStates } : {}),
  });
  using _workspace = answerRpc(WS_METHODS.threadWorkspaceGet, (input: { threadId: ThreadId }) =>
    Effect.sync(() => {
      requested.push(input.threadId);
      return {
        ...emptyWorkspace,
        threadId: input.threadId,
        items: [
          item("first", [
            { type: "ticket", target: "TK-1", state: "needs_review", label: "Review" },
          ]),
          item("second"),
        ],
      } satisfies ThreadWorkspace;
    }),
  );
  const { stack, screen } = await mountApp([held, other], 1280);
  await using _app = stack;
  // The collapsed-sidebar attention dot keeps the selected thread's workspace loaded.
  await vi.waitFor(() => expect(requested).toContain(held.id));
  const toolbar = screen.getByRole("toolbar", { name: "Side panel views" });
  const checklist = toolbar.getByRole("button", { name: "Checklist", exact: true });
  const links = toolbar.getByRole("button", { name: "Links", exact: true });
  await expect.element(checklist.getByText("2")).toBeVisible();
  await expect.element(links.getByText("Needs review")).toBeInTheDocument();
  await act(() =>
    useToolSidebarStore
      .getState()
      .dispatch({ type: "setHidden", view: "links", hidden: true, strip: true }),
  );
  await expect.element(links).not.toBeInTheDocument();
  const settings = toolbar.getByRole("button", { name: "Side panel settings" });
  await expect.element(settings.getByText("Needs review")).toBeInTheDocument();
  requested.length = 0;
  await act(() =>
    useToolSidebarStore
      .getState()
      .dispatch({ type: "lock", thread: scopeThreadRef(ENVIRONMENT_ID, other.id) }),
  );
  await expect.element(checklist.getByText("2")).not.toBeInTheDocument();
  expect(requested).not.toContain(other.id);
});

it.each(["panel", "rail", "shortcut"] as const)(
  "reveals Context and usage from a legacy %s snapshot",
  async (source) => {
    const { stack, screen } = await mountApp(
      [threadWithHistory("legacy-inspect", 1)],
      390,
      undefined,
      async () => {
        await page.viewport(390, 450);
        localStorage.setItem(
          "weavewing_tool_sidebar",
          JSON.stringify({
            version: 0,
            state: {
              open: source === "panel",
              view: source === "panel" ? "inspect" : "details",
              width: 360,
              pinned: false,
              locked: null,
            },
          }),
        );
        await useToolSidebarStore.persist.rehydrate();
        if (source === "panel") return;
        localStorage.setItem(
          "t3code:thread-context-sidebar",
          JSON.stringify({
            version: 2,
            state: { view: source === "rail" ? "inspect" : "threads", lastTool: "inspect" },
          }),
        );
        await useThreadContextSidebarStore.persist.rehydrate();
      },
    );
    await using _app = stack;
    if (source === "shortcut") await userEvent.keyboard(THREAD_VIEWS_SHORTCUT);
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    await expect
      .element(panel.getByRole("button", { name: "Context and usage" }))
      .toBeInViewport({ ratio: 1 });
    await vi.waitFor(() =>
      expect(
        panel.getByRole("region", { name: "Details", exact: true }).element().scrollTop,
      ).toBeGreaterThan(0),
    );
  },
);

it("lists bookmark to-dos in Checklist All and keeps plain bookmarks in the thread menu", async () => {
  const thread = threadWithHistory("checklist-bookmarks", 1);
  const bookmark = {
    threadId: thread.id,
    threadTitle: thread.title,
    role: "assistant" as const,
    flaggedAt: "2026-01-01T00:00:00.000Z",
    doneAt: null,
  };
  using _bookmarks = answerRpc(WS_METHODS.messageFollowUpsList, () =>
    Effect.succeed([
      { ...bookmark, messageId: MessageId.make("plain"), todo: false, excerpt: "Saved only" },
      { ...bookmark, messageId: MessageId.make("todo"), todo: true, excerpt: "Follow up" },
    ]),
  );
  const { stack, screen } = await mountApp([thread], 1280);
  await using _app = stack;
  await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
  await userEvent.click(page.getByRole("menuitem", { name: /bookmark/i }));
  await expect
    .element(page.getByRole("dialog", { name: "Bookmarks" }).getByText("Saved only"))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await act(() => useThreadContextSidebarStore.getState().show("checklist"));
  const checklist = screen.getByRole("region", { name: "Checklist", exact: true });
  const scope = checklist.getByRole("group", { name: "Checklist scope" });
  await userEvent.click(scope.getByRole("button", { name: "All", exact: true }));
  await expect.element(checklist.getByRole("group", { name: /Filter bookmark/ })).toBeVisible();
  await expect
    .element(checklist.getByRole("checkbox", { name: "Mark done: Follow up" }))
    .toBeVisible();
  expect(checklist.getByText("Saved only").query()).toBeNull();
  await expect
    .element(
      screen
        .getByRole("toolbar", { name: "Side panel views" })
        .getByRole("button", { name: "Checklist", exact: true })
        .getByText("1"),
    )
    .toBeVisible();
});

it("hides any view, opens a hidden view explicitly, and restores it by keyboard", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("picker-visibility", 1)], 390);
  await using _app = stack;
  await act(() => openInbox());
  const picker = screen.getByRole("button", { name: /^View: / });
  await expect.element(picker).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const hideMenu = page.getByRole("menuitem", { name: "Hide a view" });
  await expect.element(hideMenu).toBeVisible();
  hideMenu.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  const hideLinks = page.getByRole("menuitem", { name: "Hide Links" });
  await expect.element(hideLinks).toBeVisible();
  hideLinks.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("button", { name: /^View: Inbox/ })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(page.getByRole("menuitemradio", { name: /^Links/ }).query()).toBeNull();
  hideMenu.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  const hide = page.getByRole("menuitem", { name: "Hide Inbox" });
  await expect.element(hide).toBeVisible();
  hide.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("button", { name: /^View: Checklist/ })).toHaveFocus();
  await act(() => openInbox());
  await expect.element(screen.getByRole("button", { name: /^View: Inbox/ })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(page.getByRole("menuitemradio", { name: /^Inbox/ }).query()).toBeNull();
  const show = page.getByRole("menuitem", { name: "Show Inbox" });
  await expect.element(show).toBeVisible();
  show.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(picker).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitemradio", { name: /^Inbox/ })).toBeVisible();
});

it("explains why the last visible thread view cannot be hidden", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("last-view", 1)], 1280);
  await using _app = stack;
  await act(() => {
    const panel = useToolSidebarStore.getState();
    for (const view of ["checklist", "artifacts", "links", "activity"] as const) {
      panel.dispatch({ type: "setHidden", view, hidden: true });
    }
    openInbox();
  });
  screen.getByRole("button", { name: "Side panel settings" }).element().focus();
  await userEvent.keyboard("{Enter}");
  const hideMenu = page.getByRole("menuitem", { name: "Hide a view" });
  await expect.element(hideMenu).toBeVisible();
  hideMenu.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  const last = page.getByRole("menuitem", { name: "Hide Details" });
  await expect.element(last).toBeDisabled();
  await expect
    .element(last)
    .toHaveAccessibleDescription("Keep at least one thread view in the strip.");
});

it("respects a collapsed section when the thread views shortcut reopens its view", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("collapsed-restore", 1)], 1280);
  await using _app = stack;
  await act(() =>
    useThreadContextSidebarStore.getState().show("details", { section: "details:environments" }),
  );
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  const heading = panel.getByRole("button", { name: "Environments", exact: true });
  await expect.element(heading).toBeVisible();
  await userEvent.click(heading);
  await expect.element(heading).toHaveAttribute("aria-expanded", "false");
  await userEvent.keyboard(THREAD_VIEWS_SHORTCUT);
  await expect.element(panel).not.toBeInTheDocument();
  await userEvent.keyboard(THREAD_VIEWS_SHORTCUT);
  await expect.element(heading).toHaveAttribute("aria-expanded", "false");
});

it.each([
  [390, false],
  [1280, false],
  [390, true],
] as const)(
  "keeps restored Related in view through late links at %i with user scroll: %s",
  async (width, userScroll) => {
    const marks = Array.from({ length: 30 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      service: "web",
      timestamp: "2026-01-01T00:00:00.000Z",
      description: `Synthetic link ${i}`,
    }));
    let releaseMarks!: (next: typeof marks) => void;
    const delayedMarks = new Promise<typeof marks>((resolve) => {
      releaseMarks = resolve;
    });
    using _marks = answerRpc(WS_METHODS.threadMarksGet, () => Effect.promise(() => delayedMarks));
    const { stack, screen } = await mountApp(
      [threadWithHistory("late-links", 1)],
      width,
      undefined,
      async () => {
        localStorage.setItem(
          "weavewing_tool_sidebar",
          JSON.stringify({
            version: 0,
            state: { open: true, view: "related", width: 360, pinned: false, locked: null },
          }),
        );
        await useToolSidebarStore.persist.rehydrate();
      },
    );
    await using _app = stack;
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    const heading = panel.getByRole("button", { name: "Delegated, forked and messaged threads" });
    await expect.element(heading).toBeInViewport({ ratio: 1 });
    const scroller = panel.getByRole("region", { name: "Links", exact: true }).element();
    const above = panel.getByRole("region", { name: "Pull requests, tickets, links and files" });

    if (userScroll) {
      await act(() => {
        scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
        scroller.scrollTop = 0;
      });
    }
    await act(() => releaseMarks(marks));
    await expect.element(panel.getByText("Synthetic link 29")).toBeInTheDocument();
    if (userScroll) {
      await new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(above.element());
      });
      expect(scroller.scrollTop).toBe(0);
      return;
    }
    await expect.element(heading).toBeInViewport({ ratio: 1 });
  },
);

it("toggles the strip separately from the floating panel", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("strip", 1)], 1280);
  await using _app = stack;
  const toolbar = screen.getByRole("toolbar", { name: "Side panel views" });
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  const toggle = screen.getByRole("button", { name: "Toggle side panel", exact: true });
  const links = toolbar.getByRole("button", { name: "Links", exact: true });
  await expect.element(toolbar).toBeVisible();
  await expect.element(panel).not.toBeInTheDocument();
  const narrowWidth = widthOf("[data-thread-tiling]");
  await userEvent.click(links);
  await expect.element(panel.getByRole("heading", { name: "Links", level: 2 })).toBeVisible();
  await userEvent.click(links);
  await expect.element(panel).not.toBeInTheDocument();
  await userEvent.click(links);
  await userEvent.click(toggle);
  await expect.element(toolbar).not.toBeInTheDocument();
  await expect.element(panel).not.toBeInTheDocument();
  expect(widthOf("[data-thread-tiling]")).toBe(narrowWidth + 44);
  await userEvent.click(toggle);
  await expect.element(toolbar).toBeVisible();
  await expect.element(panel).not.toBeInTheDocument();
});

it("opens the first strip tool at full width and as a tile", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("waiting", 1)], 1280);
  await using _app = stack;
  const toolbar = screen.getByRole("toolbar", { name: "Side panel views" });
  const waiting = toolbar.getByRole("button", { name: "Waiting on you", exact: true });
  expect(toolbar.getByRole("button").elements()[0]).toBe(waiting.element());
  expect(document.querySelector("[data-waiting-on-you-row]")).toBeNull();
  await userEvent.click(waiting);
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect
    .element(panel.getByRole("heading", { name: "Waiting on you", level: 2 }))
    .toBeVisible();
  const top = panel.element().getBoundingClientRect().top;
  await userEvent.click(panel.getByRole("button", { name: "Maximize side panel" }));
  const expanded = panel.element().getBoundingClientRect();
  expect(expanded.left).toBe(0);
  expect(expanded.top).toBe(top);
  await userEvent.click(panel.getByRole("button", { name: "Open as tile" }));
  await expect
    .element(screen.getByRole("tab", { name: "Waiting on you", exact: true }))
    .toBeVisible();
  await expect.element(panel).not.toBeInTheDocument();
});
