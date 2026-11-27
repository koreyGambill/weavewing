import { EnvironmentId, ReviewId, ThreadId, type ReviewSummary } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  due: [] as ReadonlyArray<ReviewSummary>,
  active: {} as { environmentId?: string; threadId?: string },
  readable: true,
  supported: true,
  mode: "notifications",
  inApp: true,
  add: vi.fn<(options: { actionProps?: { onClick?: () => void } }) => string>(),
  close: vi.fn(),
  query: vi.fn(),
}));
vi.mock(
  import("@tanstack/react-router"),
  async (original) =>
    ({
      ...(await original<typeof import("@tanstack/react-router")>()),
      useParams: () => state.active,
    }) as never,
);
vi.mock(
  import("@effect/atom-react"),
  async (original) =>
    ({
      ...(await original<typeof import("@effect/atom-react")>()),
      useAtomValue: (_atom: unknown, select: (result: unknown) => unknown) =>
        select(AsyncResult.success(state.due)),
    }) as never,
);
vi.mock(import("../state/reviews"), () => ({ reviewArtifactsDue: state.query }) as never);
vi.mock(
  import("../state/environments"),
  () =>
    ({
      useEnvironments: () => ({
        environments: [
          {
            environmentId: "remote-environment",
            connection: { phase: "connected" },
            serverConfig: {
              environment: { capabilities: state.supported ? { reviewArtifacts: true } : {} },
            },
          },
        ],
      }),
    }) as never,
);
vi.mock(
  import("../state/session"),
  () =>
    ({
      useEnvironmentsWithScope: () => new Set(state.readable ? ["remote-environment"] : []),
    }) as never,
);
vi.mock(
  import("../hooks/useSettings"),
  () =>
    ({
      useClientSettings: () => ({
        notificationMode: state.mode,
        inAppNotificationsEnabled: state.inApp,
      }),
      getClientSettings: () => ({
        notificationMode: state.mode,
        inAppNotificationsEnabled: state.inApp,
      }),
    }) as never,
);
vi.mock(
  import("../components/ui/toast"),
  () =>
    ({
      toastManager: { add: state.add, close: state.close },
    }) as never,
);

import { useRightPanelStore } from "../rightPanelStore";
import { useThreadContextSidebarStore } from "../threadContextSidebarStore";
import { provideSideAreaContext, useToolSidebarStore } from "../toolSidebarStore";
import { ReviewReminderCoordinator } from "./ReviewReminderCoordinator";

const environmentId = EnvironmentId.make("remote-environment");
const review: ReviewSummary = {
  id: ReviewId.make("00000000-0000-4000-8000-000000000001"),
  threadId: ThreadId.make("review-thread"),
  title: "Rollout review",
  revision: 1,
  lastSubmittedRevision: null,
  remindAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T09:00:00.000Z",
};

function setup() {
  state.active = {};
  state.due = [review];
  state.readable = true;
  state.supported = true;
  state.mode = "notifications";
  state.inApp = true;
  state.add.mockReset().mockReturnValue("review-toast");
  state.close.mockReset();
  state.query.mockReset();
  useRightPanelStore.setState({ byThreadKey: {} });
  useThreadContextSidebarStore.setState(useThreadContextSidebarStore.getInitialState());
  useToolSidebarStore.setState(useToolSidebarStore.getInitialState());
}

it.each(["other-thread", "list"])(
  "announces due reviews while viewing %s and opens Questions only on click",
  async (view) => {
    setup();
    using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    using _visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const ref = scopeThreadRef(environmentId, review.threadId);
    // What a mounted side panel reports: the open route's thread, which it follows.
    using _context = {
      [Symbol.dispose]: provideSideAreaContext(() =>
        view === "list"
          ? { route: ref, selected: ref }
          : {
              route: scopeThreadRef(EnvironmentId.make("existing"), ThreadId.make("thread")),
              selected: null,
            },
      ),
    };
    if (view === "list") {
      state.active = { environmentId, threadId: review.threadId };
      useThreadContextSidebarStore.getState().show("todos", { thread: ref });
    }
    const route = view === "list" ? "/remote-environment/review-thread" : "/existing/thread";
    const initialView = useToolSidebarStore.getState().view;
    await using screen = await render(<ReviewReminderCoordinator />, { router: route });
    await vi.waitFor(() => expect(state.add).toHaveBeenCalledTimes(1));
    expect(screen.router?.state.location.pathname).toBe(route);
    expect(useToolSidebarStore.getState().view).toBe(initialView);
    state.due = [{ ...review, revision: 2 }];
    await screen.rerender(<ReviewReminderCoordinator />);
    expect(state.add).toHaveBeenCalledTimes(1);
    await act(() => state.add.mock.calls[0]?.[0].actionProps?.onClick?.());
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/remote-environment/review-thread"),
    );
    expect(useThreadContextSidebarStore.getState().artifactSelection).toEqual({
      thread: ref,
      id: review.id,
    });
    // From another thread the view waits for the navigation's arrival; on its thread it settles.
    expect(useToolSidebarStore.getState()).toMatchObject({
      open: true,
      view: "artifacts",
      locked: null,
      arrival: view === "list" ? null : ref,
    });
  },
);

it("opens a review shown on its thread for arrival after you switch away", async () => {
  setup();
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  using _visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  state.active = { environmentId, threadId: review.threadId };
  await using screen = await render(<ReviewReminderCoordinator />, {
    router: "/remote-environment/review-thread",
  });
  await vi.waitFor(() => expect(state.add).toHaveBeenCalledTimes(1));
  state.active = { environmentId: "existing", threadId: "thread" };
  await screen.rerender(<ReviewReminderCoordinator />);
  await act(() => state.add.mock.calls[0]?.[0].actionProps?.onClick?.());
  expect(useToolSidebarStore.getState().arrival).toEqual(
    scopeThreadRef(environmentId, review.threadId),
  );
});

it("respects notification permission and never asks for it", async () => {
  setup();
  const requestPermission = vi.fn();
  const notification = vi.fn();
  using _notification = stubGlobal(
    "Notification",
    Object.assign(notification, { permission: "denied", requestPermission }),
  );
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  using _visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await using _screen = await render(<ReviewReminderCoordinator />);
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(state.add).not.toHaveBeenCalled();
  expect(notification).not.toHaveBeenCalled();
  expect(requestPermission).not.toHaveBeenCalled();
});

it("does not query reminders without orchestration read access", async () => {
  setup();
  state.readable = false;
  await using _screen = await render(<ReviewReminderCoordinator />);
  expect(state.query).not.toHaveBeenCalled();
  expect(state.add).not.toHaveBeenCalled();
});

it("does not query older environments that omit review support", async () => {
  setup();
  state.supported = false;
  await using _screen = await render(<ReviewReminderCoordinator />);
  expect(state.query).not.toHaveBeenCalled();
  expect(state.add).not.toHaveBeenCalled();
});

it("opens the review from a desktop notification without starting work", async () => {
  setup();
  const created: Array<EventTarget> = [];
  class TestNotification extends EventTarget {
    static permission = "granted";
    close = vi.fn();
    constructor() {
      super();
      created.push(this);
    }
  }
  using _notification = stubGlobal("Notification", TestNotification);
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  using _visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  state.active = { environmentId, threadId: review.threadId };
  useThreadContextSidebarStore.getState().show("artifacts", {
    thread: scopeThreadRef(environmentId, review.threadId),
    artifactId: review.id,
  });
  await using screen = await render(<ReviewReminderCoordinator />, {
    router: "/remote-environment/review-thread",
  });
  await vi.waitFor(() => expect(created).toHaveLength(1));
  expect(screen.router?.state.location.pathname).toBe("/remote-environment/review-thread");
  await act(() => created[0]?.dispatchEvent(new Event("click")));
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/remote-environment/review-thread"),
  );
  expect(useThreadContextSidebarStore.getState().artifactSelection).toMatchObject({
    id: review.id,
  });
  expect(useToolSidebarStore.getState()).toMatchObject({ open: true, view: "artifacts" });
});
