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
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
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
  await expect
    .element(screen.getByRole("textbox", { name: `Message ${threads[0]!.title}` }))
    .toBeVisible();
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
  const before = {
    chat: widthOf("[data-thread-tiling]"),
    threads: widthOf("[data-app-sidebar]"),
  };
  await userEvent.click(screen.getByRole("button", { name: "Toggle side panel", exact: true }));
  const panel = screen.getByRole("complementary", { name: "Side panel" });
  await expect.element(panel).toBeVisible();
  expect(panel.element().getBoundingClientRect().width).toBe(300);
  expect(widthOf("[data-thread-tiling]")).toBe(before.chat);
  expect(widthOf("[data-app-sidebar]")).toBe(before.threads);
  await act(() => useToolSidebarStore.getState().dispatch({ type: "resize", width: 640 }));
  await vi.waitFor(() => expect(panel.element().getBoundingClientRect().width).toBe(640));
  expect(widthOf("[data-thread-tiling]")).toBe(before.chat);
  await userEvent.click(panel.getByRole("button", { name: "Maximize side panel" }));
  await expect
    .element(panel.getByRole("button", { name: "Restore side panel size" }))
    .toBeVisible();
  expect(widthOf("[data-app-sidebar]")).toBe(before.threads);
  await expect.element(screen.getByRole("navigation", { name: "Threads" })).toBeVisible();
});

it("moves focus into the side panel, returns it on Escape, and never traps it when pinned", async () => {
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
  await userEvent.click(page.getByRole("menuitemradio", { name: "Links" }));
  await expect.element(panel.getByRole("button", { name: /^View: Links/ })).toBeVisible();
  expect(useToolSidebarStore.getState().view).toBe("links");

  await userEvent.click(panel.getByRole("button", { name: "Pin side panel" }));
  const composer = screen.getByRole("textbox", { name: `Message ${thread.title}` });
  await userEvent.click(composer);
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(useToolSidebarStore.getState()).toMatchObject({ open: true, pinned: true });

  panel
    .getByRole("button", { name: /^View: Links/ })
    .element()
    .focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(panel).not.toBeInTheDocument();
  await expect.element(toggle).toHaveFocus();
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

it("starts one Todos load, for the last thread, after ten quick switches with the panel pinned", async () => {
  const threads = Array.from({ length: 10 }, (_, index) => threadWithHistory(`walk-${index}`, 1));
  const { stack, screen, router } = await mountApp(threads, 1280);
  await using _app = stack;
  const started: ThreadId[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  using _todos = answerRpc(WS_METHODS.threadListRead, (input: { readonly threadId: ThreadId }) =>
    Effect.suspend(() => {
      started.push(input.threadId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return Effect.never;
    }).pipe(Effect.ensuring(Effect.sync(() => (inFlight -= 1)))),
  );
  await act(() => {
    useToolSidebarStore.getState().dispatch({ type: "show", view: "todos" });
    useToolSidebarStore.getState().dispatch({ type: "pin" });
  });
  await expect.element(screen.getByRole("complementary", { name: "Side panel" })).toBeVisible();
  await vi.waitFor(() => expect(started).toEqual([threads[0]!.id]));
  started.length = 0;
  using _timers = fakeTimers();
  for (const thread of threads.slice(1)) {
    await act(() => router.navigate({ to: `/${ENVIRONMENT_ID}/${thread.id}` }));
  }
  expect(started).toEqual([]);
  await vi.waitFor(() => expect(inFlight).toBe(0));
  await act(() => vi.advanceTimersByTime(SIDE_AREA_SETTLE_MS));
  await vi.waitFor(() => expect(started).toEqual([threads.at(-1)!.id]));
  expect(maxInFlight).toBe(1);
  expect(useToolSidebarStore.getState().open).toBe(true);
});
