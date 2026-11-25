import {
  EnvironmentId,
  OrchestrationV2SetThreadToolOverridesError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerToolsControl, type ComposerToolsThread } from "./ComposerToolsControl";

import "~/index.css";

const state = vi.hoisted(() => ({
  permitted: true,
  run: vi.fn(),
  inventory: vi.fn(),
  inventoryPermitted: true,
}));

vi.mock(import("../../state/orchestration"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    orchestrationEnvironment: {
      ...actual.orchestrationEnvironment,
      setThreadToolOverrides: {
        ...actual.orchestrationEnvironment.setThreadToolOverrides,
        permissionAtom: () => Atom.make(state.permitted),
      },
      threadMcpServers: Object.assign((target: unknown) => Atom.make(state.inventory(target)), {
        permissionAtom: () => Atom.make(state.inventoryPermitted),
      }) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));

const fixtureInventory = {
  servers: [
    { name: "fixture-notes", connector: false, status: "connected", active: true },
    { name: "claude.ai Fixture Board", connector: true, status: "connected", active: true },
    { name: "claude.ai Fixture Mail", connector: true, status: "connected", active: false },
  ],
};

function setup(
  permitted = true,
  inventory: AsyncResult.AsyncResult<unknown, unknown> = AsyncResult.success(fixtureInventory),
  inventoryPermitted = true,
) {
  state.permitted = permitted;
  state.inventoryPermitted = inventoryPermitted;
  state.run.mockReset().mockResolvedValue({ _tag: "Success", value: { outcome: "reloaded" } });
  state.inventory.mockReset().mockReturnValue(inventory);
}

const environmentId = EnvironmentId.make("environment-test");
const provider = {
  omittedBuiltinTools: [
    "Artifact",
    "ArtifactData",
    "ArtifactComments",
    "Task",
    "Workflow",
    "ScheduleWakeup",
    "ReportFindings",
  ],
  claudeAiConnectors: "off",
} as const;
const idleThread: ComposerToolsThread = {
  id: ThreadId.make("thread-test"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  runtime: { status: "completed" },
  pendingBackgroundTasks: [],
};

const renderControl = (
  thread: ComposerToolsThread = idleThread,
  providerSettings: typeof provider | { readonly [K in keyof typeof provider]: unknown } = provider,
) =>
  render(
    <ComposerToolsControl
      environmentId={environmentId}
      thread={thread}
      provider={providerSettings as typeof provider}
      presentation="row"
    />,
  );

const dialogOf = () => page.getByRole("dialog", { name: "Tools for this thread" });

it("opens, switches and closes by keyboard, sending nothing until Reload session", async () => {
  setup();
  await using screen = await renderControl();
  const trigger = screen.getByRole("button", { name: /Tools 8 off/ });
  expect(state.run).not.toHaveBeenCalled();

  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const dialog = dialogOf();
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText("Nothing changed")).toBeVisible();

  // Opening by keyboard focuses the first switch; Tab moves down the list.
  await expect.element(dialog.getByRole("switch").first()).toHaveFocus();
  await userEvent.keyboard(" ");
  await expect.element(dialog.getByText("1 switched on, about +12,900 tokens")).toBeVisible();
  await userEvent.tab();
  await expect.element(dialog.getByRole("switch").nth(1)).toHaveFocus();
  expect(state.run).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  // Staged switches survive closing the popover.
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog.getByText("1 switched on, about +12,900 tokens")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: idleThread.id,
      toolOverrides: {
        enabledBuiltinTools: ["Artifact"],
        claudeAiConnectors: false,
        omittedMcpServers: [],
      },
    },
  });
  await expect.element(dialog).not.toBeInTheDocument();
});

it.each([
  [
    "a running turn",
    { ...idleThread, runtime: { status: "running" } },
    "A turn is running. Stop it or wait for it to finish, then reload. Your switches are kept.",
  ],
  [
    "background work",
    { ...idleThread, pendingBackgroundTasks: [{}] },
    "This session is running background agents or commands that a reload would end. Wait for them, or press Stop.",
  ],
] as const)(
  "disables Reload session during %s and keeps the switches",
  async (_name, thread, text) => {
    setup();
    await using screen = await renderControl(thread);
    await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
    const dialog = dialogOf();
    await userEvent.click(dialog.getByRole("switch").nth(1));
    await expect.element(dialog.getByText(text)).toBeVisible();
    await expect.element(dialog.getByRole("switch").nth(1)).toBeChecked();
    await expect.element(dialog.getByRole("button", { name: "Reload session" })).toBeDisabled();
  },
);

it("shows a reload as pending until its outcome arrives, then keeps the popover on failure", async () => {
  setup();
  let resolveOutcome: (value: unknown) => void = () => {};
  state.run.mockReturnValue(new Promise((resolve) => (resolveOutcome = resolve)));
  await using screen = await renderControl();
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  const dialog = dialogOf();
  await userEvent.click(dialog.getByRole("switch").first());
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  await expect.element(dialog.getByText("Reloading the session")).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Reloading…" })).toBeDisabled();

  resolveOutcome({ _tag: "Success", value: { outcome: "reload-failed" } });
  await expect.element(dialog.getByRole("button", { name: "Reload session" })).toBeEnabled();
});

it.each([
  ["pending", "Reloading the session", { name: "Reloading…", disabled: true }],
  [
    "failed",
    "The last reload did not confirm the old session stopped, so it may still be running. Reload again, or press Stop.",
    { name: "Reload session", disabled: false },
  ],
] as const)("shows a %s reload recorded on the thread", async (status, text, button) => {
  setup();
  await using screen = await renderControl({
    ...idleThread,
    toolOverridesReload: { commandId: "command-test" as never, status },
  });
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  const dialog = dialogOf();
  await expect.element(dialog.getByText(text)).toBeVisible();
  const reload = dialog.getByRole("button", { name: button.name });
  await (button.disabled
    ? expect.element(reload).toBeDisabled()
    : expect.element(reload).toBeEnabled());
});

it("disables Reload session without permission to operate the thread", async () => {
  setup(false);
  await using screen = await renderControl();
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  await expect.element(dialogOf().getByRole("button", { name: "Reload session" })).toBeDisabled();
});

it("says so, and requests nothing, without permission to list MCP servers", async () => {
  setup(true, AsyncResult.success(fixtureInventory), false);
  await using screen = await renderControl();
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  await expect
    .element(dialogOf().getByText("Your access can't list this thread's MCP servers."))
    .toBeVisible();
  expect(state.inventory).not.toHaveBeenCalled();
});

it("shows the server's refusal in the footer and keeps the popover open", async () => {
  setup();
  state.run.mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(
        new OrchestrationV2SetThreadToolOverridesError({
          threadId: idleThread.id,
          reason: "busy",
        }),
      ),
    ),
  );
  await using screen = await renderControl();
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  const dialog = dialogOf();
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  await expect
    .element(dialog.getByText("A turn is running. Stop it or wait for it to finish, then reload."))
    .toBeVisible();
});

it("lists MCP servers only once open, and gives no estimate for some of the connectors", async () => {
  setup();
  await using screen = await renderControl();
  expect(state.inventory).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  expect(state.inventory).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: idleThread.id },
  });
  const dialog = dialogOf();
  const connectors = page.getByRole("list", { name: "claude.ai connectors" });
  // With the provider keeping them out and the group off, no connector can be picked alone.
  await expect.element(connectors.getByRole("switch")).not.toBeInTheDocument();
  await userEvent.click(dialog.getByText("Every connector on your Claude account"));
  await userEvent.click(connectors.getByRole("switch").nth(1));
  await expect.element(dialog.getByText("1 switched on, 1 MCP server off")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: idleThread.id,
      toolOverrides: {
        enabledBuiltinTools: [],
        claudeAiConnectors: true,
        omittedMcpServers: ["claude.ai Fixture Mail"],
      },
    },
  });
});

it("never shows connectors left to Claude Code as off", async () => {
  setup();
  await using screen = await renderControl(idleThread, {
    ...provider,
    claudeAiConnectors: "inherit",
  });
  await userEvent.click(screen.getByRole("button", { name: /Tools 7 off/ }));
  const dialog = dialogOf();
  await expect.element(dialog.getByText("Left to Claude Code")).toBeVisible();
  // Only the connector the live session loaded can be left out on its own.
  const connectors = page.getByRole("list", { name: "claude.ai connectors" });
  await expect.element(connectors.getByRole("switch")).toBeChecked();
  await expect.element(connectors.getByText(/not loaded in this session/)).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Turn on for this thread" }));
  await expect.element(dialog.getByText(/On for this thread/)).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Leave to Claude Code" })).toBeVisible();
});

it.each([
  ["loading", AsyncResult.initial(true), "Loading MCP servers…"],
  [
    "failed",
    AsyncResult.failure(Cause.fail("probe failed")),
    "Could not list this thread's MCP servers.",
  ],
] as const)(
  "keeps built-in tools usable while the inventory is %s",
  async (name, inventory, text) => {
    setup(true, inventory);
    await using screen = await renderControl();
    await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
    const dialog = dialogOf();
    await expect.element(dialog.getByText(text)).toBeVisible();
    if (name === "failed") {
      await expect.element(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
    }
    await userEvent.click(dialog.getByRole("switch").first());
    await expect.element(dialog.getByText("1 switched on, about +12,900 tokens")).toBeVisible();
  },
);
