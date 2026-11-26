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
import { toastManager } from "../ui/toast";
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
  state.run
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { outcome: "restart-scheduled" } });
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
        claudeAiConnectors: "default",
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

it("saves and closes, with no pending state, and reads all on when nothing is left out", async () => {
  setup();
  await using screen = await renderControl(idleThread, {
    omittedBuiltinTools: [],
    claudeAiConnectors: "on",
  });
  using toast = vi.spyOn(toastManager, "add");
  await userEvent.click(screen.getByRole("button", { name: /Tools all on/ }));
  const dialog = dialogOf();
  await userEvent.click(dialog.getByRole("switch").first());
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  await expect.element(dialog).not.toBeInTheDocument();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Tools changed: 1 MCP server off. This applies from the next message.",
    }),
  );
});

it("reads all on when the thread switched everything on", async () => {
  setup();
  await using screen = await renderControl({
    ...idleThread,
    toolOverrides: {
      enabledBuiltinTools: [...provider.omittedBuiltinTools],
      claudeAiConnectors: "on",
      omittedMcpServers: [],
    },
  });
  await expect.element(screen.getByRole("button", { name: /Tools all on/ })).toBeVisible();
});

it.each([
  ["while the inventory loads", AsyncResult.initial(true)],
  [
    "when the inventory lacks the left-out name",
    AsyncResult.success({ servers: [fixtureInventory.servers[0]] }),
  ],
] as const)("gives no token sum %s", async (_name, inventory) => {
  setup(true, inventory);
  await using screen = await renderControl({
    ...idleThread,
    toolOverrides: {
      enabledBuiltinTools: [],
      claudeAiConnectors: "on",
      omittedMcpServers: ["claude.ai Fixture Mail"],
    },
  });
  await userEvent.click(screen.getByRole("button", { name: /Tools 1 on/ }));
  const dialog = dialogOf();
  await userEvent.click(dialog.getByRole("switch").first());
  await expect
    .element(dialog.getByText("2 switched on, 1 MCP server off", { exact: true }))
    .toBeVisible();
});

it("gives no token sum for an unplaced left-out server with the connectors off", async () => {
  setup(true, AsyncResult.success({ servers: [fixtureInventory.servers[0]] }));
  await using screen = await renderControl(
    {
      ...idleThread,
      toolOverrides: {
        enabledBuiltinTools: [],
        claudeAiConnectors: "default",
        omittedMcpServers: ["claude.ai Fixture Mail"],
      },
    },
    provider,
  );
  await userEvent.click(screen.getByRole("button", { name: /Tools 9 off/ }));
  const dialog = dialogOf();
  await userEvent.click(dialog.getByRole("switch").first());
  await expect
    .element(dialog.getByText("1 switched on, 1 MCP server off", { exact: true }))
    .toBeVisible();
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

it("lists MCP servers only once open, and picks one connector in a single step", async () => {
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
  // With the provider keeping them out, picking one connector turns the group on for it alone.
  await userEvent.click(connectors.getByRole("switch").first());
  await expect.element(dialog.getByText("1 switched on, 1 MCP server off")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: idleThread.id,
      toolOverrides: {
        enabledBuiltinTools: [],
        claudeAiConnectors: "on",
        omittedMcpServers: ["claude.ai Fixture Mail"],
      },
    },
  });
});

it("keeps a saved explicit setting when the group is switched off and back on unsaved", async () => {
  setup();
  // Saved on for the thread, and the provider default later changed to match it.
  await using screen = await renderControl(
    {
      ...idleThread,
      toolOverrides: { enabledBuiltinTools: [], claudeAiConnectors: "on", omittedMcpServers: [] },
    },
    { ...provider, claudeAiConnectors: "on" },
  );
  await userEvent.click(screen.getByRole("button", { name: /Tools 1 on · 7 off/ }));
  const dialog = dialogOf();
  const group = dialog.getByRole("switch", { name: /claude\.ai connectors/ });
  await expect.element(dialog.getByText(/set for this thread/)).toBeVisible();
  await userEvent.click(group);
  await userEvent.click(group);
  await expect.element(group).toBeChecked();
  await expect.element(dialog.getByText(/set for this thread/)).toBeVisible();
  await expect.element(dialog.getByText("Nothing changed")).toBeVisible();
});

it("counts a partial connector selection and says switching the group off resets it", async () => {
  setup();
  await using screen = await renderControl(idleThread, { ...provider, claudeAiConnectors: "on" });
  await userEvent.click(screen.getByRole("button", { name: /Tools 1 on · 7 off/ }));
  const dialog = dialogOf();
  await expect
    .element(dialog.getByText("All 2 connectors on; follows the provider default"))
    .toBeVisible();
  const connectors = page.getByRole("list", { name: "claude.ai connectors" });
  await userEvent.click(connectors.getByRole("switch").first());
  await expect
    .element(dialog.getByText("1 of 2 connectors on; follows the provider default"))
    .toBeVisible();
  await userEvent.click(dialog.getByRole("switch", { name: /claude\.ai connectors/ }));
  await expect
    .element(dialog.getByText("Connectors off, individual choices reset; set for this thread"))
    .toBeVisible();
});

it("follows an On default, turns the connectors off for the thread, and back clears it", async () => {
  setup();
  await using screen = await renderControl(idleThread, { ...provider, claudeAiConnectors: "on" });
  await userEvent.click(screen.getByRole("button", { name: /Tools 1 on · 7 off/ }));
  const dialog = dialogOf();
  const group = dialog.getByRole("switch", { name: /claude\.ai connectors/ });
  await expect.element(group).toBeChecked();
  await expect.element(dialog.getByText(/follows the provider default/)).toBeVisible();
  const connectors = page.getByRole("list", { name: "claude.ai connectors" });
  await expect.element(connectors.getByRole("switch").first()).toBeChecked();

  await userEvent.click(group);
  await expect.element(group).not.toBeChecked();
  await expect.element(dialog.getByText(/set for this thread/)).toBeVisible();
  await expect.element(connectors.getByRole("switch").first()).not.toBeChecked();
  // Back to the default stores no setting of the thread's own, so nothing has changed.
  await userEvent.click(group);
  await expect.element(dialog.getByText("Nothing changed")).toBeVisible();
  await userEvent.click(group);
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: idleThread.id,
      toolOverrides: { enabledBuiltinTools: [], claudeAiConnectors: "off", omittedMcpServers: [] },
    },
  });
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

it("keeps Reload session in view while the lists scroll in a short window", async () => {
  await page.viewport(640, 420);
  setup();
  await using screen = await renderControl();
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  const dialog = dialogOf();
  await expect.element(page.getByRole("list", { name: "claude.ai connectors" })).toBeVisible();
  const button = dialog.getByRole("button", { name: "Reload session" }).element();
  const tools = page.getByRole("list", { name: "Built-in tools" }).element();
  const scroller = tools.parentElement!;
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  const inView = () => {
    const box = button.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  };
  expect(inView()).toBe(true);
  scroller.scrollTop = scroller.scrollHeight;
  expect(inView()).toBe(true);
});
