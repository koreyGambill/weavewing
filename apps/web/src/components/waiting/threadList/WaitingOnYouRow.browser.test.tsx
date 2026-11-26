import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../../test/render";
import { useToolSidebarStore } from "../../../toolSidebarStore";
import { SidebarProvider } from "../../ui/sidebar";
import type { WaitingThread } from "./waitingThreads.logic";
import { WaitingOnYouRow } from "./WaitingOnYouRow";

const entry = (id: string, title: string): WaitingThread => ({
  key: `env-1:${id}`,
  ref: { environmentId: "env-1" as EnvironmentId, threadId: id as ThreadId },
  title,
  counts: [{ kind: "qa", count: 1 }],
  discussing: 0,
  updatedAtMs: 0,
});

vi.mock(import("./waitingOnYou"), () => ({
  waitingThreadsAtom: null as never,
  useWaitingOnYou: () => ({
    threads: {
      waiting: [entry("t1", "Retry toast"), entry("t2", "Webhook backoff")],
      onAgent: [{ ...entry("t3", "Release notes"), counts: [], discussing: 1 }],
    },
    inboxes: [],
    unread: 0,
    visible: true,
  }),
}));

it("opens from the keyboard, moves with arrows, and hands focus back to the row on Escape", async () => {
  await page.viewport(1280, 800);
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <WaitingOnYouRow />
    </SidebarProvider>,
  );
  const row = screen.getByRole("button", { name: "Waiting on you: 2 threads waiting on you" });
  await expect.element(row).toBeVisible();

  row.element().focus();
  await userEvent.keyboard("{Enter}");
  const first = screen.getByRole("button", { name: "Retry toast: 1 change to check" });
  await vi.waitFor(() => expect(document.activeElement).toBe(first.element()));
  await expect
    .element(screen.getByRole("button", { name: "Release notes: 1 discussing" }))
    .toBeVisible();

  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Webhook backoff: 1 change to check" }).element(),
  );
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /Open Inbox/ }).element());
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(first.element());

  await userEvent.keyboard("{Escape}");
  await expect.element(first).not.toBeInTheDocument();
  await vi.waitFor(() => expect(document.activeElement).toBe(row.element()));
});

it("opens the Inbox view in the side panel from the list", async () => {
  await page.viewport(1280, 800);
  useToolSidebarStore.getState().dispatch({ type: "close" });
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <WaitingOnYouRow />
    </SidebarProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Waiting on you/ }));
  await userEvent.click(screen.getByRole("button", { name: /Open Inbox/ }));
  expect(useToolSidebarStore.getState()).toMatchObject({ open: true, view: "inbox" });
});
