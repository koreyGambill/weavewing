import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map(({ environmentId }) => environmentId))) as never,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.command) as never,
}));
vi.mock(import("../settings/SettingsScopeContext"), async (original) => {
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "ctrl+alt+left", command: "workspace.tile.focusLeft" },
    { key: "ctrl+alt+h", command: "workspace.tile.focusLeft" },
    { key: "ctrl+shift+x", command: "workspace.tile.maximize" },
    { key: "mod+n", command: "chat.new" },
  ]);
  const environments = ["env-a", "env-b"].map((environmentId) => ({
    environmentId,
    label: environmentId,
    serverConfig: { keybindings, keybindingsConfigPath: null, availableEditors: [] },
  }));
  return {
    ...(await original()),
    SettingsScopeProvider: (({ children }: { children: ReactNode }) => children) as never,
    useSettingsScope: (() => ({
      scope: { kind: "environment" },
      environment: environments[0],
      environments,
      connectedEnvironments: environments,
      targets: [],
      target: null,
    })) as never,
  };
});

import { ShortcutReferenceDialog } from "./ShortcutReferenceDialog";

function setup() {
  mocks.command.mockReset();
  mocks.command.mockResolvedValue({ _tag: "Success", value: undefined });
}

it("searches command names and configured keys while keeping aliases together", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const onOpenChange = vi.fn();
  // The reference has no navigation.
  await using screen = await render(<ShortcutReferenceDialog open onOpenChange={onOpenChange} />, {
    router: false,
  });
  await expect.element(screen.getByRole("dialog", { name: "Shortcut reference" })).toBeVisible();
  const pillFor = (label: string) =>
    screen.getByRole("button", { name: new RegExp(`^Edit shortcut for ${label}:`) });
  const left = pillFor("Focus Tile Left");
  await expect.element(left.nth(0)).toHaveAccessibleName(/Ctrl\+Alt\+H$/);
  await expect.element(left.nth(1)).toHaveAccessibleName(/Ctrl\+Alt\+Left$/);
  const search = screen.getByRole("textbox", { name: "Search shortcuts" });
  await userEvent.fill(search, "ctrl+shift+x");
  await expect.element(pillFor("Maximize Tile")).toBeVisible();
  await expect.element(left.first()).not.toBeInTheDocument();
  await userEvent.fill(search, "chat.new");
  await expect.element(pillFor("Chat: New")).toBeVisible();
  await expect.element(screen.getByRole("region", { name: "Workspace" })).not.toBeInTheDocument();
  await userEvent.fill(search, "no such shortcut");
  await expect.element(screen.getByText("No matching shortcuts.", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
});

it("records a new shortcut in place and saves it to every connected environment", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const onOpenChange = vi.fn();
  await using screen = await render(<ShortcutReferenceDialog open onOpenChange={onOpenChange} />, {
    router: false,
  });
  const pill = screen.getByRole("button", { name: /^Edit shortcut for Chat: New:/ });
  await expect.element(pill).toBeVisible();
  // The modal dialog's inert layer swallows pointer events in this harness, so drive the DOM.
  (pill.element() as HTMLElement).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Keybinding for Chat: New" }))
    .toHaveFocus();

  await userEvent.keyboard("{Control>}k{/Control}");
  const save = screen.getByRole("button", { name: "Save" });
  await expect.element(save).toBeEnabled();
  (save.element() as HTMLElement).click();

  await vi.waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(2));
  const input = {
    command: "chat.new",
    key: "mod+k",
    replace: { command: "chat.new", key: "mod+n" },
  };
  expect(mocks.command.mock.calls).toEqual([
    [{ environmentId: "env-a", input }],
    [{ environmentId: "env-b", input }],
  ]);
  expect(onOpenChange).not.toHaveBeenCalled();
});
