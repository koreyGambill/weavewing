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
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));

function setup(permitted = true) {
  state.permitted = permitted;
  state.run.mockReset().mockResolvedValue({ _tag: "Success", value: { reloaded: true } });
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

const renderControl = (thread: ComposerToolsThread = idleThread) =>
  render(
    <ComposerToolsControl
      environmentId={environmentId}
      thread={thread}
      provider={provider}
      presentation="row"
    />,
  );

it("opens, switches and closes by keyboard, sending nothing until Reload session", async () => {
  setup();
  await using screen = await renderControl();
  const trigger = screen.getByRole("button", { name: /Tools 8 off/ });
  expect(state.run).not.toHaveBeenCalled();

  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const dialog = page.getByRole("dialog", { name: "Tools left out of this thread" });
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
    const dialog = page.getByRole("dialog", { name: "Tools left out of this thread" });
    await userEvent.click(dialog.getByRole("switch").nth(1));
    await expect.element(dialog.getByText(text)).toBeVisible();
    await expect.element(dialog.getByRole("switch").nth(1)).toBeChecked();
    await expect.element(dialog.getByRole("button", { name: "Reload session" })).toBeDisabled();
  },
);

it("disables Reload session without permission to operate the thread", async () => {
  setup(false);
  await using screen = await renderControl();
  await userEvent.click(screen.getByRole("button", { name: /Tools 8 off/ }));
  await expect.element(page.getByRole("button", { name: "Reload session" })).toBeDisabled();
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
  const dialog = page.getByRole("dialog", { name: "Tools left out of this thread" });
  await userEvent.click(dialog.getByRole("button", { name: "Reload session" }));
  await expect
    .element(dialog.getByText("A turn is running. Stop it or wait for it to finish, then reload."))
    .toBeVisible();
});
