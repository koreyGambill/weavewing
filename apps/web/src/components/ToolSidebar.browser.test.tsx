import { createMemoryHistory } from "@tanstack/react-router";
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
import { getRouter } from "~/router";
import { useDropdownTerminalStore } from "~/dropdownTerminalStore";
import { useToolSidebarStore } from "~/toolSidebarStore";
import { SIDE_AREA_SETTLE_MS } from "./ToolSidebar";
import {
  ENVIRONMENT_ID,
  answerRpc,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

async function mountApp(threads: ReadonlyArray<FakeThread>, width: number) {
  const stack = new AsyncDisposableStack();
  const initialSize = { width: window.innerWidth, height: window.innerHeight };
  stack.defer(() => page.viewport(initialSize.width, initialSize.height));
  await page.viewport(width, 800);
  useToolSidebarStore.setState({
    open: false,
    view: "details",
    width: 300,
    pinned: false,
    locked: null,
    maximized: false,
  });
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

function widthOf(selector: string) {
  const element = document.querySelector(selector);
  expect(element).not.toBeNull();
  return element!.getBoundingClientRect().width;
}

it("covers the chat without changing the chat's or the thread list's width", async () => {
  const { stack, screen } = await mountApp([threadWithHistory("cover", 2)], 1280);
  await using _app = stack;
  const widths = () => ({
    main: widthOf("main"),
    chat: widthOf("[data-thread-tiling]"),
    threads: widthOf("[data-app-sidebar]"),
  });
  const before = widths();
  await userEvent.click(screen.getByRole("button", { name: "Toggle side panel", exact: true }));
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

it("moves focus into the side panel, tabs through it and out while pinned, and returns focus on Escape", async () => {
  const thread = threadWithHistory("focus", 1);
  const { stack, screen } = await mountApp([thread], 1280);
  await using _app = stack;
  const toggle = screen.getByRole("button", { name: "Toggle side panel", exact: true });
  await userEvent.click(toggle);
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  const picker = panel.getByRole("button", { name: /^View: Details/ });
  await expect.element(picker).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitemradio", { name: "Links" })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(page.getByRole("menuitemradio", { name: "Links" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(panel.getByRole("button", { name: /^View: Links/ })).toHaveFocus();
  expect(useToolSidebarStore.getState().view).toBe("links");

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
  await expect.element(toggle).toHaveFocus();
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
  await act(() => useToolSidebarStore.getState().dispatch({ type: "show", view: "links" }));
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
  await userEvent.click(screen.getByRole("button", { name: "Toggle side panel", exact: true }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  await userEvent.click(screen.getByRole("textbox", { name: `Message ${thread.title}` }));
  await expect.element(panel).not.toBeInTheDocument();
});

it("loads Todos only for the last of ten quick switches, showing the view at once", async () => {
  const threads = Array.from({ length: 10 }, (_, index) => threadWithHistory(`walk-${index}`, 1));
  const { stack, screen, router } = await mountApp(threads, 1280);
  await using _app = stack;
  const started: string[] = [];
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
          const left = (inFlight.get(input.threadId) ?? 1) - 1;
          if (left === 0) inFlight.delete(input.threadId);
          else inFlight.set(input.threadId, left);
        }),
      ),
    );
  using _list = answerRpc(WS_METHODS.threadListRead, hold("listRead"));
  using _artifacts = answerRpc(WS_METHODS.threadArtifactList, hold("artifactList"));
  await act(() => {
    useToolSidebarStore.getState().dispatch({ type: "show", view: "todos" });
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
  await expect.element(panel.getByRole("region", { name: "Todos" })).toBeVisible();
  expect(panel.element().querySelector('[data-slot="skeleton"]')).toBeNull();
  await act(() => vi.advanceTimersByTime(SIDE_AREA_SETTLE_MS));
  const last = threads.at(-1)!.id;
  await vi.waitFor(() =>
    expect(started.toSorted()).toEqual([`artifactList ${last}`, `listRead ${last}`]),
  );
  expect(maxThreadsInFlight).toBe(1);
  expect(useToolSidebarStore.getState().open).toBe(true);
});
