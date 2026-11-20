import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { installFakeEnvironment } from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { dropdownTerminalRef } from "../dropdownTerminal.logic";
import { useDropdownTerminalStore } from "../dropdownTerminalStore";
import { CONVERSATION_TAB_ID, getTileGroups } from "../threadTileLayout";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  selectThreadRightPanelState,
  selectThreadTileLayout,
  useRightPanelStore,
} from "../rightPanelStore";
import type { EnvironmentPresentation } from "../state/environments";
import { ConfirmDialogHost } from "./ConfirmDialogHost";
import { DropdownTerminalButton, DropdownTerminalHost } from "./DropdownTerminal";
import "../index.css";

const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    environments: [] as EnvironmentPresentation[],
    primary: null as EnvironmentId | null,
    shown: null as EnvironmentId | null,
    permitted: new Set<EnvironmentId>(),
    knownSessions: null as KnownTerminalSession[] | null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    publish() {
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../state/environments", async (load) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await load<typeof import("../state/environments")>()),
    useEnvironments: () => ({
      environments: useSyncExternalStore(fixture.subscribe, () => fixture.environments),
    }),
    usePrimaryEnvironmentId: () => fixture.primary,
  };
});
vi.mock("../hooks/useThreadRouteTarget", async (load) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await load<typeof import("../hooks/useThreadRouteTarget")>()),
    useThreadRouteRef: () => {
      const shown = useSyncExternalStore(fixture.subscribe, () => fixture.shown);
      return shown ? scopeThreadRef(shown, ThreadId.make("shown")) : null;
    },
  };
});
vi.mock("../state/session", async (load) => ({
  ...(await load<typeof import("../state/session")>()),
  useEnvironmentScope: (id: EnvironmentId) => fixture.permitted.has(id),
  readEnvironmentScope: (id: EnvironmentId) => fixture.permitted.has(id),
  useEnvironmentsWithScope: () => fixture.permitted,
}));
vi.mock("../state/terminalSessions", async (load) => {
  const { Atom } = await import("effect/reactivity");
  const { applyTerminalAttachStreamEvent, EMPTY_TERMINAL_SESSION_STATE } =
    await import("@t3tools/client-runtime/state/terminal");
  const sessions = Atom.family((key: string) => {
    const [threadId, terminalId, cwd]: [ThreadId, string, string] = JSON.parse(key);
    return Atom.make({
      ...EMPTY_TERMINAL_SESSION_STATE,
      ...applyTerminalAttachStreamEvent(EMPTY_TERMINAL_SESSION_STATE, {
        type: "snapshot",
        snapshot: {
          threadId,
          terminalId,
          cwd,
          worktreePath: null,
          status: "running",
          pid: 123,
          history: `Saved output from ${cwd}\r\n`.repeat(46) + "$ ",
          exitCode: null,
          exitSignal: null,
          label: "Terminal",
          updatedAt: "2026-11-19T00:00:00.000Z",
        },
      }),
    });
  });
  return {
    ...(await load<typeof import("../state/terminalSessions")>()),
    useKnownTerminalSessions: (ref: { environmentId: EnvironmentId; threadId: ThreadId }) =>
      fixture.knownSessions?.filter(
        ({ target }) =>
          target.environmentId === ref.environmentId && target.threadId === ref.threadId,
      ) ?? null,
    attachedTerminalSessionAtom: (
      environmentId: EnvironmentId,
      input: { threadId: ThreadId; terminalId: string; cwd: string },
    ) => sessions(JSON.stringify([input.threadId, input.terminalId, input.cwd, environmentId])),
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));

function setup() {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const noFolder = EnvironmentId.make("no-folder");
  const readOnly = EnvironmentId.make("read-only");
  fixture.knownSessions = null;
  fixture.primary = local;
  fixture.shown = remote;
  fixture.permitted = new Set([local, remote, noFolder]);
  fixture.environments = (
    [
      [local, "This PC", "/home/local"],
      [remote, "Build machine", "/home/remote"],
      [noFolder, "No-folder machine", undefined],
      [readOnly, "Read-only machine", "/home/read-only"],
    ] as const
  ).map(
    ([id, label, scratchWorkspaceRoot]) =>
      ({
        environmentId: id,
        label,
        entry: {
          target:
            id === local
              ? new PrimaryConnectionTarget({
                  environmentId: local,
                  label: "This PC",
                  httpBaseUrl: "http://localhost",
                  wsBaseUrl: "ws://localhost",
                })
              : new BearerConnectionTarget({
                  environmentId: id,
                  label,
                  connectionId: `pair:${id}`,
                }),
        },
        connection: { phase: "connected" },
        serverConfig: { scratchWorkspaceRoot, settings: { scratchStartDirectory: "" } },
      }) as EnvironmentPresentation,
  );
  useDropdownTerminalStore.setState({ open: false, expanded: false, selectedTarget: null });
  useRightPanelStore.setState({ byThreadKey: {} });
  return { local, remote };
}

function fixtureApp(controls?: React.ReactNode) {
  return (
    <AppAtomRegistryProvider>
      {controls}
      <ConfirmDialogHost />
      <DropdownTerminalHost />
    </AppAtomRegistryProvider>
  );
}

it("keeps a chosen machine across thread navigation, disconnects and reopening", async () => {
  using _environment = installFakeEnvironment([]);
  const { local, remote } = setup();
  await using _screen = await render(fixtureApp());
  const terminal = page.getByRole("region", { name: "Drop-down terminal" });
  const picker = terminal.getByRole("button", { name: /Run on/ });
  const input = terminal.getByRole("textbox", { name: "Terminal input" });
  const scrollback = terminal.getByRole("scrollbar", { name: "Terminal scrollback" });
  await userEvent.keyboard("{Control>}j{/Control}");
  await expect.element(picker).toHaveAccessibleName("Run on This PC");
  await expect.element(input).toHaveFocus();
  await expect.element(scrollback).toBeVisible();
  const initialEnvironments = fixture.environments;
  await act(() => {
    fixture.environments = initialEnvironments.filter(
      (environment) => environment.environmentId === remote,
    );
    fixture.publish();
  });
  await expect.element(picker).toHaveAccessibleName("Run on This PC");
  await expect.element(terminal.getByRole("status").getByText("Disconnected")).toBeVisible();
  await expect.element(input).not.toBeInTheDocument();
  await act(() => {
    fixture.environments = initialEnvironments;
    fixture.publish();
  });
  await expect.element(input).toHaveFocus();
  const tabs = terminal.getByRole("tab");
  await userEvent.keyboard("{Control>}a{/Control}t");
  await expect.poll(() => tabs.elements()).toHaveLength(2);

  await picker.click();
  await expect
    .element(page.getByRole("menuitem", { name: /No-folder machine/ }))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByRole("menuitem", { name: /Read-only machine/ }))
    .toHaveAttribute("aria-disabled", "true");
  await page.getByRole("menuitem", { name: "Use current thread’s machine" }).click();
  await expect.element(picker).toHaveAccessibleName("Run on Build machine");
  await expect.element(input).toHaveFocus();

  await expect.element(scrollback).toBeVisible();
  await act(() => {
    fixture.shown = local;
    fixture.publish();
  });
  await expect.element(picker).toHaveAccessibleName("Run on Build machine");
  await userEvent.keyboard("{Control>}j{/Control}");
  await expect.element(terminal).not.toBeInTheDocument();
  await userEvent.keyboard("{Control>}j{/Control}");
  await expect.element(picker).toHaveAccessibleName("Run on Build machine");
  await expect.element(input).toHaveFocus();

  await act(() => {
    fixture.environments = fixture.environments.filter(
      (environment) => environment.environmentId !== remote,
    );
    fixture.publish();
  });
  await expect.element(terminal.getByRole("status").getByText("Disconnected")).toBeVisible();
  await expect.element(picker).toHaveAccessibleName("Run on Build machine");
  await expect.element(input).not.toBeInTheDocument();

  await picker.click();
  await page.getByRole("menuitem", { name: "This PC" }).click();
  await expect.element(picker).toHaveAccessibleName("Run on This PC");
  await expect.element(input).toHaveFocus();
  await expect.poll(() => tabs.elements()).toHaveLength(2);
  await expect.element(scrollback).toBeVisible();
});

it("handles an outside click and keeps the toggle, shell and dialogs working", async () => {
  using _environment = installFakeEnvironment([]);
  setup();
  const outsideAction = vi.fn();
  await using _screen = await render(
    fixtureApp(
      <>
        <DropdownTerminalButton />
        <button
          className="fixed bottom-4 left-4"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            outsideAction();
          }}
        >
          Underlying action
        </button>
      </>,
    ),
  );
  const outside = page.getByRole("button", { name: "Underlying action" });
  const toggle = page.getByRole("button", { name: "Drop-down terminal", exact: true });
  const terminal = page.getByRole("region", { name: "Drop-down terminal" });
  const input = terminal.getByRole("textbox", { name: "Terminal input" });

  await toggle.click();
  await expect.element(input).toHaveFocus();
  const canvas = page.elementLocator(terminal.element().querySelector("canvas")!);
  await canvas.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Select all", exact: true }).click();
  await expect.element(input).toHaveFocus();
  await terminal.getByRole("button", { name: "Close Terminal 1", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(terminal.getByRole("tab", { name: "Terminal 1" })).toBeVisible();

  const pin = terminal.getByRole("button", { name: "Pin drop-down terminal" });
  await pin.click();
  await expect.element(pin).toHaveAttribute("aria-pressed", "true");
  await outside.click();
  await expect.element(outside).toHaveFocus();
  await expect.element(terminal).toBeVisible();
  await toggle.click();
  await expect.element(terminal).not.toBeInTheDocument();
  await toggle.click();
  await expect.element(pin).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Control>}a{/Control}{Shift>}P{/Shift}");
  await expect.element(pin).toHaveAttribute("aria-pressed", "false");

  await outside.click();
  await expect.element(terminal).not.toBeInTheDocument();
  expect(outsideAction).toHaveBeenCalledTimes(2);
  await expect.element(outside).toHaveFocus();

  await toggle.click();
  await expect.element(terminal.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
  await expect.element(input).toHaveFocus();
  await toggle.click();
  await expect.element(terminal).not.toBeInTheDocument();
  await expect.element(toggle).toHaveFocus();
});

it("inherits the source tab directory for new tabs and splits on the selected machine", async () => {
  using _environment = installFakeEnvironment([]);
  const { local, remote } = setup();
  const ref = dropdownTerminalRef(local);
  const store = useRightPanelStore.getState();
  store.openTerminal(ref, "project", { cwd: "/project/at-launch", worktreePath: null });
  store.openTerminal(ref, "moved", { cwd: "/other/moved-worktree", worktreePath: null });
  store.applyTileAction(ref, { type: "close-tab", tabId: CONVERSATION_TAB_ID });
  fixture.knownSessions = [
    {
      target: { ...ref, terminalId: "project" },
      state: combineTerminalSessionState(
        {
          threadId: ref.threadId,
          terminalId: "project",
          label: "Project",
          cwd: "/project/on-server",
          worktreePath: null,
          status: "running",
          pid: 123,
          hasRunningSubprocess: false,
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-11-19T00:00:00.000Z",
        },
        EMPTY_TERMINAL_BUFFER_STATE,
      ),
    },
  ];
  const terminalPaths = (environmentId: EnvironmentId) =>
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      dropdownTerminalRef(environmentId),
    ).surfaces.flatMap((surface) =>
      surface.kind === "terminal" ? [surface.launchContext?.cwd] : [],
    );

  await using _screen = await render(fixtureApp());
  const terminal = page.getByRole("region", { name: "Drop-down terminal" });
  await userEvent.keyboard("{Control>}j{/Control}");
  await terminal.getByRole("tab", { name: "Project", exact: true }).click();
  await terminal.getByRole("button", { name: "New tab", exact: true }).click();
  expect(terminalPaths(local)).toEqual([
    "/project/at-launch",
    "/other/moved-worktree",
    "/project/on-server",
  ]);

  await terminal.getByRole("tab", { name: "moved", exact: true }).click();
  await terminal.getByRole("button", { name: "Tile actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /^New tile below/ }).click();
  await expect
    .poll(() => terminalPaths(local))
    .toEqual([
      "/project/at-launch",
      "/other/moved-worktree",
      "/project/on-server",
      "/other/moved-worktree",
    ]);

  await terminal.getByRole("button", { name: /Run on/ }).click();
  await page.getByRole("menuitem", { name: "Build machine", exact: true }).click();
  await expect.poll(() => terminalPaths(remote)).toEqual(["/home/remote"]);
});

it("moves keyboard focus between split terminals with Leader+h", async () => {
  using _environment = installFakeEnvironment([]);
  const { local } = setup();
  const ref = dropdownTerminalRef(local);
  const store = useRightPanelStore.getState();
  store.openTerminal(ref, "left", { cwd: "/left", worktreePath: null });
  store.openTerminal(ref, "right", { cwd: "/right", worktreePath: null });
  const layout = () => selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, ref);
  const leftGroup = getTileGroups(layout()).find((group) => group.tabs.includes("terminal:left"))!;
  store.applyTileAction(ref, {
    type: "split",
    tabId: "terminal:right",
    targetGroupId: leftGroup.id,
    axis: "horizontal",
    side: "after",
    groupId: "right-group",
    splitId: "terminal-split",
  });
  expect(getTileGroups(layout()).some((group) => group.id === "right-group")).toBe(true);
  store.applyTileAction(ref, { type: "close-tab", tabId: CONVERSATION_TAB_ID });

  await using _screen = await render(fixtureApp());
  const terminal = page.getByRole("region", { name: "Drop-down terminal" });
  await userEvent.keyboard("{Control>}j{/Control}");
  const focusedTile = () =>
    document.activeElement instanceof HTMLTextAreaElement
      ? document.activeElement.closest("[data-tile-content]")?.getAttribute("data-tile-content")
      : null;
  await expect.element(terminal.getByRole("tab", { name: "right", exact: true })).toBeVisible();
  await vi.waitFor(() => expect(focusedTile()).toBe("terminal:right"));
  expect(layout().focusedGroupId).toBe("right-group");

  await userEvent.keyboard("{Control>}a{/Control}h");
  expect(layout().focusedGroupId).toBe(leftGroup.id);
  await vi.waitFor(() => expect(focusedTile()).toBe("terminal:left"));
});
