import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
// Drop targets come from measured layout, which needs the app's styles.
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

// A drop's command never confirms in the fake environment: its optimistic placement holds every
// row still, and it holds later commands on that thread. So each test drops a different thread
// once, from the same list, since the app's thread state outlives a test. The route holds the
// first thread open and neither test drags it.
const threads = [
  threadWithHistory("open", 1),
  threadWithHistory("first", 1),
  threadWithHistory("second", 1),
];

async function renderSidebar() {
  await page.viewport(1400, 900);
  // A failed wait below still unmounts the app and the fake environment.
  await using stack = new AsyncDisposableStack();
  stack.use(installFakeEnvironment(threads));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  stack.use(
    await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    }),
  );
  await expect.element(page.getByRole("button", { name: /^Thread second/ })).toBeVisible();
  return stack.move();
}

const row = (thread: (typeof threads)[number]) =>
  document.querySelector<HTMLElement>(
    `li[data-thread-item="${CSS.escape(scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, thread.id)))}"]`,
  )!;

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

// Rows can move during a drag, so the target is read where it is on each step.
async function dragOnto(thread: (typeof threads)[number], targetY: () => number) {
  const from = row(thread).getBoundingClientRect();
  const x = from.x + 40;
  await act(() => {
    row(thread).firstElementChild!.dispatchEvent(pointer("pointerdown", x, from.y + 20));
    document.dispatchEvent(pointer("pointermove", x, from.y + 30));
  });
  // dnd-kit measures droppables after activation, so the pointer travels in steps like a hand.
  for (const step of [0.25, 0.5, 0.75, 1, 1]) {
    const y = from.y + 30 + (targetY() - from.y - 30) * step;
    await act(() => document.dispatchEvent(pointer("pointermove", x, y)));
  }
  await act(() => document.dispatchEvent(pointer("pointerup", x, targetY())));
}

it("pins a thread dragged to the top of the list without groups", async () => {
  await using _app = await renderSidebar();
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  // The shift guard ignores presses on rows that moved in the last 500ms, as these did on load;
  // a far-future clock puts that window behind them.
  using _clock = vi.spyOn(performance, "now").mockReturnValue(1e12);
  // The lower row, so the drag has room to travel up to Pinned.
  const pinned = threads[2]!;
  await dragOnto(
    pinned,
    () =>
      document.querySelector('[data-testid="sidebar-pinned-header"]')!.getBoundingClientRect().top +
      2,
  );
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "thread.pin", threadId: pinned.id }),
    ),
  );
});

it("settles a thread dragged onto the Settled header without groups", async () => {
  await using _app = await renderSidebar();
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  using _clock = vi.spyOn(performance, "now").mockReturnValue(1e12);
  const settled = threads[1]!;
  await dragOnto(settled, () => {
    const bounds = document
      .querySelector('[data-testid="sidebar-settled-shelf-toggle"]')!
      .getBoundingClientRect();
    return bounds.y + bounds.height / 2;
  });
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "thread.settle", threadId: settled.id }),
    ),
  );
});
