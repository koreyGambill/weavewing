import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../../test/render";
import { useToolSidebarStore } from "../../../toolSidebarStore";
import { openInbox } from "../../inbox/openInbox";
import { SidebarProvider } from "../../ui/sidebar";
import { openWaitingList } from "./waitingListCommand";
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
  useWaitingOnYou: () => ({
    threads: {
      waiting: [entry("t1", "Retry toast"), entry("t2", "Webhook backoff")],
      onAgent: [{ ...entry("t3", "Release notes"), counts: [], discussing: 1 }],
    },
    inboxes: [],
    unread: 0,
    severity: null,
    machines: null,
    visible: true,
    enabledCount: 1,
  }),
}));

it("loads without the cards and chat markdown, so the always-mounted row stays light", () => {
  // ChatMarkdown's file icons add this sprite when their module loads.
  expect(document.getElementById("t3code-pierre-file-icon-sprite")).toBeNull();
});

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
  const first = page.getByRole("button", { name: "Retry toast: 1 change to check" });
  await vi.waitFor(() => expect(document.activeElement).toBe(first.element()));
  await expect
    .element(page.getByRole("button", { name: "Release notes: 1 discussing" }))
    .toBeVisible();

  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    page.getByRole("button", { name: "Webhook backoff: 1 change to check" }).element(),
  );
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(page.getByRole("button", { name: /Open Inbox/ }).element());
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
  await userEvent.click(page.getByRole("button", { name: /Open Inbox/ }));
  expect(useToolSidebarStore.getState()).toMatchObject({ open: true, view: "inbox" });
});

it("opens the Inbox instead of a list anchored to a row the thread list hides", async () => {
  await page.viewport(1280, 800);
  await using screen = await render(
    <SidebarProvider defaultOpen>
      {/* A rail view covering the thread list hides it the same way. */}
      <div hidden>
        <WaitingOnYouRow />
      </div>
    </SidebarProvider>,
  );
  expect(openWaitingList()).toBe(false);
  expect(screen.container.querySelector("[data-waiting-list-item]")).toBeNull();
});

it("opens the side panel's Inbox at every width", async () => {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    await page.viewport(width, height);
    useToolSidebarStore.getState().dispatch({ type: "close" });
    openInbox();
    expect(useToolSidebarStore.getState()).toMatchObject({ open: true, view: "inbox" });
  }
});
