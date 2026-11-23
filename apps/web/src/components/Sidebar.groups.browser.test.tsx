import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
// The drop indicator is positioned from measured layout, which needs the app's styles.
import "~/index.css";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  dispatchedCommands,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
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

it("drops a thread into a group at the indicator, and a grouped thread still drags onto Pinned", async () => {
  await page.viewport(1400, 900);
  const [grouped, loose] = [threadWithHistory("grouped", 1), threadWithHistory("loose", 1)];
  using _environment = installFakeEnvironment([grouped, loose], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const keyOf = (thread: typeof grouped) =>
    scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, thread.id));
  const storageKey = "t3code:sidebar:thread-groups:v1";
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      groups: [{ id: "demo", name: "Demo", collapsed: false, threadKeys: [keyOf(grouped)] }],
      ungroupedOrder: [],
      ungroupedCollapsed: false,
    }),
  );
  using _storage = { [Symbol.dispose]: () => localStorage.removeItem(storageKey) };
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${grouped.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const row = (thread: typeof grouped) =>
    document.querySelector<HTMLElement>(`li[data-thread-item="${CSS.escape(keyOf(thread))}"]`);
  const header = page.getByRole("button", { name: /^Demo(?! group actions)/ });
  await expect.element(header).toBeVisible();
  await expect.element(page.getByRole("button", { name: /^Thread loose/ })).toBeVisible();
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  // The shift guard ignores presses on rows that moved in the last 500ms, as these did on load;
  // a far-future clock puts that window behind them.
  using _clock = vi.spyOn(performance, "now").mockReturnValue(1e12);
  // Autoscroll can move the list during a drag, so targets are read where they are now.
  const centerY = (element: Element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.y + bounds.height / 2;
  };
  const headerY = () => centerY(header.element());
  const startDrag = async (thread: typeof grouped, targetY: () => number) => {
    const from = row(thread)!.getBoundingClientRect();
    const x = from.x + 40;
    await act(() => {
      row(thread)!.firstElementChild!.dispatchEvent(pointer("pointerdown", x, from.y + 20));
      document.dispatchEvent(pointer("pointermove", x, from.y + 40));
    });
    // dnd-kit measures droppables after activation, so the pointer travels in steps like a hand.
    for (const step of [0.25, 0.5, 0.75, 1, 1]) {
      const y = from.y + 40 + (targetY() - from.y - 40) * step;
      await act(() => document.dispatchEvent(pointer("pointermove", x, y)));
    }
    return () => act(() => document.dispatchEvent(pointer("pointerup", x, targetY())));
  };
  const drop = await startDrag(loose, headerY);
  const indicator = page.getByTestId("sidebar-group-drop-indicator");
  await expect.element(indicator).toBeInTheDocument();
  // The line sits on the gap above the group's first row, where the thread will land.
  expect(
    Math.abs(
      indicator.element().getBoundingClientRect().top - row(grouped)!.getBoundingClientRect().top,
    ),
  ).toBeLessThan(2);
  await drop();
  await expect.element(indicator).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(
      row(loose)!.compareDocumentPosition(row(grouped)!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(storageKey)!).groups[0].threadKeys).toEqual([
      keyOf(loose),
      keyOf(grouped),
    ]);
  });
  // Membership travels with the thread so other machines group it the same way.
  expect(dispatchedCommands()).toContainEqual(
    expect.objectContaining({
      type: "thread.sidebar-group.set",
      threadId: loose.id,
      group: "Demo",
    }),
  );

  // The drop moved rows, so the guard's window starts again.
  _clock.mockReturnValue(2e12);
  const pinnedTop = () =>
    document.querySelector('[data-testid="sidebar-pinned-header"]')!.getBoundingClientRect().top +
    2;
  const pinDrop = await startDrag(loose, pinnedTop);
  await expect.element(indicator).not.toBeInTheDocument();
  await pinDrop();
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "thread.pin", threadId: loose.id }),
    ),
  );
  // Pinning leaves the group membership for when the thread is unpinned.
  expect(JSON.parse(localStorage.getItem(storageKey)!).groups[0].threadKeys).toContain(
    keyOf(loose),
  );
});
