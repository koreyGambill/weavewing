import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({
  title: "",
  activeThread: null as EnvironmentThreadShell | null,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadShell: () => persisted.activeThread,
}));
const openMenu = vi.hoisted(() => vi.fn());
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {} }),
}));

import { render, stubGlobal } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";
import { makeThreadFixture } from "../../test-fixtures";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    persisted.activeThread = null;
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("keeps the parent glyph working during a delegated thread wait", async () => {
  persisted.title = "Coordinating agents";
  const thread = makeThreadFixture();
  const waitingThread: EnvironmentThreadShell = {
    ...thread,
    blockedOnThreadWait: true,
    runtime: {
      status: "running",
      activeRunId: RunId.make("parent-run"),
      providerName: "Codex",
      providerInstanceId: thread.providerInstanceId,
      lastError: null,
      updatedAt: thread.updatedAt,
    },
  };
  persisted.activeThread = waitingThread;
  await using screen = await render(header(persisted.title));
  await expect.element(screen.getByRole("img", { name: /, working$/ })).toBeInTheDocument();

  const backgroundWait = {
    ...waitingThread,
    runtime: { ...waitingThread.runtime!, status: "idle" as const, activeRunId: null },
    pendingBackgroundTasks: [{ taskId: "child", kind: "subagent" as const }],
  };
  persisted.activeThread = backgroundWait;
  await screen.rerender(header(persisted.title));
  await expect.element(screen.getByRole("img", { name: /, working$/ })).toBeInTheDocument();

  for (const hasPending of ["hasPendingApprovals", "hasPendingUserInput"] as const) {
    persisted.activeThread = { ...backgroundWait, [hasPending]: true };
    await screen.rerender(header(persisted.title));
    await expect.element(screen.getByRole("img", { name: /, working$/ })).not.toBeInTheDocument();
  }

  for (const kind of ["command", "monitor"] as const) {
    persisted.activeThread = {
      ...backgroundWait,
      pendingBackgroundTasks: [{ taskId: "server", kind }],
    };
    await screen.rerender(header(persisted.title));
    await expect.element(screen.getByRole("img", { name: /, working$/ })).not.toBeInTheDocument();
  }
  persisted.activeThread = { ...backgroundWait, pendingBackgroundTasks: [] };
  await screen.rerender(header(persisted.title));
  await expect.element(screen.getByRole("img", { name: /, working$/ })).not.toBeInTheDocument();
});

it("opens the thread menu on a desktop title click without waiting", async () => {
  persisted.activeThread = null;
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("New thread"));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

it("keeps the Escape that cancels a rename from also reaching window shortcuts", async () => {
  persisted.title = "New thread";
  await using screen = await render(header(persisted.title));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
  const input = screen.getByRole("textbox", { name: "Thread title" });
  await input.fill("Unsaved title");

  // The thread find bar closes from a window keydown listener that skips handled events.
  const windowEscapes: boolean[] = [];
  const recordEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") windowEscapes.push(event.defaultPrevented);
  };
  window.addEventListener("keydown", recordEscape);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("keydown", recordEscape),
  };
  await userEvent.keyboard("{Escape}");

  await expect.element(input).not.toBeInTheDocument();
  expect(persisted.title).toBe("New thread");
  expect(windowEscapes).toEqual([true]);
});
