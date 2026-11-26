import { EnvironmentId } from "@t3tools/contracts";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import {
  BranchToolbarEnvironmentSelector,
  type BranchToolbarEnvironmentSelectorHandle,
} from "../BranchToolbarEnvironmentSelector";
import { MenuItem } from "../ui/menu";
import { ComposerRow } from "./ComposerRow";
import { COMPOSER_ROW_PRIORITY, openComposerRowControl } from "./composerRowItems";

const STUDIO = EnvironmentId.make("row-test-studio");
const BUILD = EnvironmentId.make("row-test-build");
const ENVIRONMENTS: ReadonlyArray<EnvironmentOption> = [
  {
    environmentId: STUDIO,
    projectId: null,
    label: "Studio",
    isPrimary: true,
    onThisComputer: true,
    machine: "server",
  },
  {
    environmentId: BUILD,
    projectId: null,
    label: "Build box",
    isPrimary: false,
    onThisComputer: false,
    machine: "server",
  },
];

function NarrowRow() {
  const computer = useRef<BranchToolbarEnvironmentSelectorHandle>(null);
  return (
    <div data-slot="composer-shell" className="@container/composer-surface w-64">
      <textarea aria-label="Prompt" />
      <ComposerRow
        items={[
          {
            id: "computer",
            priority: COMPOSER_ROW_PRIORITY.computer,
            openPopup: () => computer.current?.open(),
            renderRowItem: () => (
              <BranchToolbarEnvironmentSelector
                ref={computer}
                envLocked={false}
                environmentId={STUDIO}
                availableEnvironments={ENVIRONMENTS}
                onEnvironmentChange={() => {}}
              />
            ),
            renderMenuRow: ({ openPopover }) => (
              <MenuItem onClick={() => openPopover(() => computer.current?.open())}>
                Computer
              </MenuItem>
            ),
          },
          {
            id: "wide",
            priority: null,
            renderRowItem: () => <span className="inline-block w-56">Wide item</span>,
          },
        ]}
      />
    </div>
  );
}

it("opens the computer's picker from its shortcut while it sits in the thread menu", async () => {
  await import("~/index.css");
  await using _screen = await render(<NarrowRow />);
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-composer-row-item="computer"][data-in-menu]'),
    ).not.toBeNull(),
  );
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  (await prompt.element()).focus();

  const shell = document.querySelector('[data-slot="composer-shell"]');
  expect(openComposerRowControl(shell, "composer.host")).toBe(true);
  const picker = page.getByRole("listbox");
  await expect
    .element(picker.getByRole("option", { name: /Build box/ }), { timeout: 3000 })
    .toBeVisible();
  const menuButton = (
    await page.getByRole("button", { name: "Thread menu" }).element()
  ).getBoundingClientRect();
  const pickerBox = (await picker.element()).getBoundingClientRect();
  // Anchored to ⋯: beside it vertically, whichever side has room, and overlapping it across.
  expect(pickerBox.bottom <= menuButton.top + 1 || pickerBox.top >= menuButton.bottom - 1).toBe(
    true,
  );
  expect(pickerBox.left).toBeLessThan(menuButton.right);
  expect(pickerBox.right).toBeGreaterThan(menuButton.left);

  await userEvent.keyboard("{Escape}");
  await expect.element(picker).not.toBeInTheDocument();
  await expect.element(prompt).toHaveFocus();
});
