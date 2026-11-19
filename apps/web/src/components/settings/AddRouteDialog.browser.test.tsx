import { Atom, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  connectSshEnvironment: vi.fn<() => Promise<AtomCommandResult<void, Error>>>(async () =>
    AsyncResult.success(undefined),
  ),
  refresh: () => {},
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectSshEnvironment: mocks.connectSshEnvironment as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: [],
    isPending: false,
    error: null,
    refresh: mocks.refresh,
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
}));
vi.mock(import("~/state/server"), async (original) => ({
  ...(await original()),
  primaryServerKeybindingsAtom: Atom.make([]) as never,
}));

import type { EnvironmentPresentation } from "~/state/environments";
import { AddRouteDialog } from "./AddRouteDialog";

const moonborn = {
  environmentId: "moonborn",
  label: "Moonborn",
  relayManaged: false,
} as unknown as EnvironmentPresentation;

function Owner() {
  const [routeTarget, setRouteTarget] = useState<EnvironmentPresentation | null>(null);
  return (
    <AppAtomRegistryProvider>
      <button type="button" onClick={() => setRouteTarget(moonborn)}>
        Open route dialog
      </button>
      <AddRouteDialog
        routeTarget={routeTarget}
        savedEnvironments={[]}
        onClose={() => setRouteTarget(null)}
      />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.connectSshEnvironment.mockClear();
  return stubGlobal("desktopBridge", {});
}

const remoteCard = () => page.getByRole("button", { name: /Link or address/ });
const sshCard = () => page.getByRole("button", { name: /^SSH/ });
const addRoute = () => page.getByRole("dialog").getByRole("button", { name: "Add route" });

async function openDialogOnSsh() {
  await userEvent.click(page.getByRole("button", { name: "Open route dialog" }));
  await userEvent.click(sshCard());
  await expect.element(sshCard()).toHaveAttribute("aria-pressed", "true");
}

async function expectDefaultModeAfterReopen() {
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Open route dialog" }));
  await expect.element(remoteCard()).toHaveAttribute("aria-pressed", "true");
  await expect.element(sshCard()).toHaveAttribute("aria-pressed", "false");
  await expect.element(page.getByPlaceholder("backend.example.com")).toBeInTheDocument();
}

describe("AddRouteDialog", () => {
  it("reopens on Link or address after adding an SSH route", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(addRoute());
    expect(mocks.connectSshEnvironment).toHaveBeenCalledOnce();

    await expectDefaultModeAfterReopen();
  });

  it("drops an SSH error when switching to Link or address", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    mocks.connectSshEnvironment.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("ssh: connection refused"))),
    );
    await openDialogOnSsh();
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(addRoute());
    await expect.element(page.getByText(/connection refused/)).toBeInTheDocument();

    await userEvent.click(remoteCard());
    await expect.element(page.getByText(/connection refused/)).not.toBeInTheDocument();
  });

  it("clears the form after dismissing it, and ignores an add that finishes after", async () => {
    using _bridge = setup();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.fill(page.getByPlaceholder("root"), "maria");
    await userEvent.fill(page.getByPlaceholder("22"), "2222");
    await userEvent.keyboard("{Escape}");

    await expectDefaultModeAfterReopen();
    await expect.element(page.getByPlaceholder("backend.example.com")).toHaveValue("");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("");
    await userEvent.click(sshCard());
    await expect.element(page.getByPlaceholder("Search hosts or type devbox")).toHaveValue("");
    await expect.element(page.getByPlaceholder("root")).toHaveValue("");
    await expect.element(page.getByPlaceholder("22")).toHaveValue("");

    let finishConnection!: (result: AtomCommandResult<void, Error>) => void;
    const pending = new Promise<AtomCommandResult<void, Error>>((resolve) => {
      finishConnection = resolve;
    });
    mocks.connectSshEnvironment.mockImplementationOnce(() => pending);
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(addRoute());
    await userEvent.keyboard("{Escape}");
    await expectDefaultModeAfterReopen();
    finishConnection(AsyncResult.failure(Cause.fail(new Error("dismissed SSH attempt"))));
    await expect.element(addRoute()).toBeEnabled();
    await expect.element(page.getByText(/dismissed SSH attempt/)).not.toBeInTheDocument();
  });
});
