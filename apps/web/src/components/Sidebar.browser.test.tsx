import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import * as scratchProject from "../hooks/useScratchProject";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { useCatalogEnvironmentIds, useEnvironments } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { Sidebar as SidebarFrame, SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useScratchProject", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    {
      mode: "normal",
      current: false,
      button: "New thread in idle",
      tooltip: "New thread in idle",
      opens: "default place",
    },
    {
      mode: "boring",
      current: false,
      button: "New thread in idle",
      tooltip: "New thread in idle",
      opens: "default place",
    },
    {
      mode: "boring",
      current: true,
      button: "New thread in active",
      tooltip: "New thread in active",
      opens: "current project",
    },
    {
      mode: "boring",
      current: false,
      button: "New thread in current project",
      tooltip: "No current project, so this starts in idle",
      opens: "default place",
    },
  ] as const)("$mode sidebar, current=$current: $button opens the $opens", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")];
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    const startDefaultPlace = vi.fn().mockResolvedValue(true);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: scenario.current
        ? (makeThreadFixture({
            environmentId: currentProjectRef.environmentId,
            projectId: currentProjectRef.projectId,
          }) as never)
        : null,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    // The resolver says New thread goes to "idle"; the tooltip and the click must agree.
    vi.mocked(scratchProject.useDefaultPlace).mockReturnValue({
      place: {
        kind: "project",
        projectRef: { environmentId: projects[1]!.environmentId, projectId: projects[1]!.id },
        unavailable: null,
      },
      label: "idle",
    });
    vi.mocked(scratchProject.readScratchProjectActions).mockReturnValue({
      startDefaultPlace,
    } as never);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const button = screen.getByRole("button", { name: scenario.button, exact: true });
    await userEvent.hover(button);
    await expect.element(screen.getByText(scenario.tooltip)).toBeVisible();
    await userEvent.click(button);

    expect(openCommandPalette).not.toHaveBeenCalled();
    if (scenario.opens === "current project") {
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
      expect(startDefaultPlace).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(startDefaultPlace).toHaveBeenCalledOnce());
      expect(startThread).not.toHaveBeenCalled();
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

it("alternates the current thread outline only on ordinary row clicks", async () => {
  await page.viewport(1280, 800);
  const activeProject = project("active");
  const threads = [threadShell(activeProject.id, 0), threadShell(activeProject.id, 1)];
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  const setRoute = (threadId: ThreadId) =>
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId },
    });
  setRoute(threads[0]!.id);
  const sidebar = () => (
    <>
      <style>{appCss}</style>
      <SidebarProvider>
        <SidebarFrame collapsible="none" className="h-80">
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarFrame>
      </SidebarProvider>
    </>
  );
  await using screen = await render(sidebar());
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  const first = screen.getByRole("button", { name: /^Thread 0/ });
  const second = screen.getByRole("button", { name: /^Thread 1/ });
  const expectOutline = async (active: typeof first, color: "green" | "yellow") => {
    const tint = getComputedStyle(document.documentElement)
      .getPropertyValue(`--weavewing-${color}`)
      .trim();
    await expect.element(active).toHaveStyle(`outline: 2px solid ${tint}`);
    await expect.element(active === first ? second : first).toHaveStyle("outline-style: none");
  };

  await userEvent.click(first);
  await expectOutline(first, "green");
  await userEvent.click(first);
  await expectOutline(first, "yellow");

  await userEvent.click(second, {
    modifiers: [isMacPlatform(navigator.platform) ? "Meta" : "Control"],
  });
  expect(navigate).toHaveBeenCalledTimes(2);
  await expectOutline(first, "yellow");

  await act(() => second.element().focus());
  await userEvent.keyboard("{Enter}");
  expect(navigate).toHaveBeenCalledTimes(3);
  setRoute(threads[1]!.id);
  await screen.rerender(sidebar());
  await expect.element(second).toHaveAttribute("aria-current", "page");
  await expect.element(second).toHaveFocus();
  await expectOutline(second, "yellow");

  await userEvent.click(second);
  await expectOutline(second, "green");
});

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    // A real wall-clock minute tick mid-test re-renders every row and reads as a leak.
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar computer filter", () => {
  const laptop = EnvironmentId.make("laptop-env");
  const desk = EnvironmentId.make("desk-env");
  const laptopThreadId = ThreadId.make("laptop-1");
  const deskThreadId = ThreadId.make("desk-1");
  const groupsKey = "t3code:sidebar:thread-groups:v1";

  // Two servers on two computers, one project and one thread on each.
  function computerFixture(
    stack: DisposableStack,
    options: { routeThreadRef?: ScopedThreadRef; chosen?: readonly string[] } = {},
  ) {
    const projects = [
      { ...project("alpha"), environmentId: laptop },
      { ...project("beta"), environmentId: desk },
    ];
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      makeThreadFixture({
        environmentId: laptop,
        id: laptopThreadId,
        projectId: projects[0]!.id,
        title: "Laptop thread",
      }),
      makeThreadFixture({
        environmentId: desk,
        id: deskThreadId,
        projectId: projects[1]!.id,
        title: "Desk thread",
      }),
    ]);
    const routeThreadRef = options.routeThreadRef ?? {
      environmentId: laptop,
      threadId: ThreadId.make("laptop-route"),
    };
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [laptop, { hostname: "laptop", environment: { capabilities: {} } }],
        [desk, { hostname: "desk-pc", environment: { capabilities: {} } }],
      ]) as never,
    );
    stack.defer(() => vi.mocked(useServerConfigs).mockRestore());
    vi.mocked(useCatalogEnvironmentIds).mockReturnValue({ ids: [laptop, desk], ready: true });
    stack.defer(() => vi.mocked(useCatalogEnvironmentIds).mockRestore());
    vi.mocked(useEnvironments).mockReturnValue({
      isReady: true,
      environments: [
        { environmentId: laptop, label: "WSL", displayUrl: null },
        { environmentId: desk, label: "Windows", displayUrl: null },
      ],
    } as never);
    stack.defer(() => vi.mocked(useEnvironments).mockRestore());
    vi.mocked(scratchProject.useDefaultPlace).mockReturnValue({
      place: { kind: "none" },
      label: null,
    } as never);
    // A choice already in the store is what a reload restores; the store test covers storage.
    useUiStateStore.getState().setSidebarEnvironmentScopeIds(options.chosen ?? []);
    stack.defer(() => useUiStateStore.getState().setSidebarEnvironmentScopeIds([]));
    stack.defer(() => useUiStateStore.getState().setSidebarProjectScopeKeys([]));
  }

  const sidebar = () => (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  // The filter's popup renders in a portal, outside the sidebar's container.
  const openFilter = (screen: { getByRole: typeof page.getByRole }) =>
    userEvent.click(screen.getByRole("combobox", { name: /^Filter threads by project/ }));

  it("lists servers under their computer and hides threads from servers left out", async () => {
    using stack = new DisposableStack();
    computerFixture(stack);
    await using screen = await render(sidebar());
    await expect.element(screen.getByText("Desk thread").first()).toBeVisible();

    await openFilter(screen);
    const computers = page.getByRole("group", { name: "Computers" });
    await expect.element(computers.getByText("laptop")).toBeVisible();
    await expect.element(computers.getByText("desk-pc")).toBeVisible();
    await userEvent.click(computers.getByRole("button", { name: "WSL" }));

    await expect.element(screen.getByText("Desk thread")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Laptop thread").first()).toBeVisible();
    expect(useUiStateStore.getState().sidebarEnvironmentScopeIds).toEqual([laptop]);
    await expect
      .element(screen.getByRole("combobox", { name: /computers: WSL/ }))
      .toBeInTheDocument();
  });

  it("keeps a remembered choice, needs the project filter to match too, and clears on Show all", async () => {
    using stack = new DisposableStack();
    computerFixture(stack, { chosen: [laptop] });
    await using screen = await render(sidebar());
    await expect.element(screen.getByText("Laptop thread").first()).toBeVisible();
    await expect.element(screen.getByText("Desk thread")).not.toBeInTheDocument();

    // beta lives on the desk server, which the computer filter leaves out: nothing matches both.
    await openFilter(screen);
    await userEvent.click(page.getByRole("option", { name: /^beta/ }));
    await expect.element(screen.getByText("Laptop thread")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Desk thread")).not.toBeInTheDocument();
    await openFilter(screen);
    await userEvent.click(page.getByRole("option", { name: /^alpha/ }));
    await expect.element(screen.getByText("Laptop thread").first()).toBeVisible();

    await openFilter(screen);
    await userEvent.click(page.getByRole("option", { name: /^All projects/ }));
    await openFilter(screen);
    await userEvent.click(
      page.getByRole("group", { name: "Computers" }).getByRole("button", { name: "Show all" }),
    );
    await expect.element(screen.getByText("Desk thread").first()).toBeVisible();
    expect(useUiStateStore.getState().sidebarEnvironmentScopeIds).toEqual([]);
  });

  it("shows only a mixed group's threads on chosen servers while filtered", async () => {
    using stack = new DisposableStack();
    localStorage.setItem(
      groupsKey,
      JSON.stringify({
        groups: [
          {
            id: "mixed",
            name: "Mixed",
            collapsed: false,
            threadKeys: [`${laptop}:${laptopThreadId}`, `${desk}:${deskThreadId}`],
          },
        ],
        ungroupedOrder: [],
        ungroupedCollapsed: false,
      }),
    );
    stack.defer(() => localStorage.removeItem(groupsKey));
    computerFixture(stack, { chosen: [laptop] });
    await using screen = await render(sidebar());

    await expect.element(screen.getByRole("button", { name: /^Mixed\s*1$/ })).toBeVisible();
    await expect.element(screen.getByText("Laptop thread").first()).toBeVisible();
    await expect.element(screen.getByText("Desk thread")).not.toBeInTheDocument();
  });

  it("lists the open thread from a computer left out without clearing the filter", async () => {
    using stack = new DisposableStack();
    computerFixture(stack, {
      chosen: [laptop],
      routeThreadRef: { environmentId: desk, threadId: deskThreadId },
    });
    await using screen = await render(sidebar());

    await expect.element(screen.getByText("Desk thread").first()).toBeVisible();
    expect(useUiStateStore.getState().sidebarEnvironmentScopeIds).toEqual([laptop]);
    await expect
      .element(screen.getByRole("combobox", { name: /computers: WSL/ }))
      .toBeInTheDocument();
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});
