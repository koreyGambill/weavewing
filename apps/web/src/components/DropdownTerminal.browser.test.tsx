import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { installFakeEnvironment } from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { useDropdownTerminalStore } from "../dropdownTerminalStore";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentPresentation } from "../state/environments";
import { DropdownTerminalHost } from "./DropdownTerminal";
import "../index.css";

const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    environments: [] as EnvironmentPresentation[],
    primary: null as EnvironmentId | null,
    shown: null as EnvironmentId | null,
    permitted: new Set<EnvironmentId>(),
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
    useKnownTerminalSessions: () => null,
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

function fixtureApp() {
  return (
    <AppAtomRegistryProvider>
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
  await expect
    .element(terminal.getByText("This machine is disconnected.", { exact: true }))
    .toBeVisible();
  await expect.element(picker).toHaveAccessibleName("Run on Build machine");
  await expect.element(input).not.toBeInTheDocument();

  await picker.click();
  await page.getByRole("menuitem", { name: "This PC" }).click();
  await expect.element(picker).toHaveAccessibleName("Run on This PC");
  await expect.element(input).toHaveFocus();
  await expect.poll(() => tabs.elements()).toHaveLength(2);
  await expect.element(scrollback).toBeVisible();
});
