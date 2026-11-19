import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { type FilesystemBrowseInput, ProjectId, WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { openCommandPalette } from "~/commandPaletteBus";
import { AppRoot } from "~/AppRoot";
// The draft route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { openDraftProjectPicker } from "~/draftProjectPicker";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  answerRpc,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("drills through folders with repeated Tab and opens with Enter in the where-line and palette", async () => {
  using _environment = installFakeEnvironment([], {
    extraProjects: [
      { id: ProjectId.make("project-alpha"), title: "alpha" },
      { id: ProjectId.make("project-code"), title: "code" },
    ],
  });
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, ({ partialPath }: FilesystemBrowseInput) =>
    Effect.succeed({
      parentPath:
        partialPath === "~/"
          ? "/workspace"
          : partialPath === "~/code/"
            ? "/workspace/code"
            : "/workspace/alpha",
      entries:
        partialPath === "~/"
          ? [{ name: "code", fullPath: "/workspace/code" }]
          : partialPath === "~/code/"
            ? [{ name: "alpha", fullPath: "/workspace/alpha" }]
            : [],
    }),
  );
  using _projectFile = answerRpc(WS_METHODS.projectsReadFile, () =>
    Effect.succeed({
      relativePath: "t3.json",
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
    }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-manual-order");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: ENVIRONMENT_ID,
  });
  useComposerDraftStore.getState().setPrompt(draftId, "Keep this unsent prompt");

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // The shell snapshot has arrived once the sidebar lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(trigger));
  const search = page.getByRole("combobox", { name: "Project name or path" });
  await expect.element(search).toHaveFocus();
  const current = page.getByRole("option").first();
  await expect.element(current.getByText("render", { exact: true })).toBeVisible();
  await expect.element(current.getByText("Current", { exact: true })).toBeVisible();
  await userEvent.type(search, "workspace/alpha");
  await expect.element(page.getByRole("option", { name: /alpha/ })).toBeVisible();
  expect(page.getByRole("option").elements()).toHaveLength(1);
  await userEvent.clear(search);
  await userEvent.type(search, "~/co");
  await expect.element(page.getByRole("option", { name: /code/ })).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.element(search).toHaveValue("~/code/");
  await expect.element(page.getByRole("option", { name: /alpha/ })).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => expect(search.element()).toHaveValue("~/code/alpha/"));
  await expect.element(search).toHaveFocus();
  await expect.element(page.getByRole("option").first()).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(document.querySelector("[data-draft-project-trigger]")?.textContent).toContain("alpha"),
  );
  await expect.element(search).not.toBeInTheDocument();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentSelection).toBe(
    "auto",
  );
  expect(
    useComposerDraftStore.getState().getDraftSession(draftId)?.loadBalancedEnvironmentId,
  ).toBeNull();
  using _columns = new DisposableStack();
  const otherColumn = document.createElement("div");
  otherColumn.dataset.tileContent = "terminal";
  const otherInput = document.createElement("input");
  otherColumn.append(otherInput);
  document.body.append(otherColumn);
  _columns.defer(() => otherColumn.remove());
  await userEvent.click(page.elementLocator(otherInput));
  expect(openDraftProjectPicker(null)).toBe(false);
  openCommandPalette({ open: "new-thread-in" });
  await expect.element(page.getByRole("combobox", { name: "Project name or path" })).toHaveFocus();
  await expect
    .element(page.getByRole("option").first().getByText("alpha", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "All machines", exact: true }))
    .toBeVisible();
  await userEvent.type(search, "~/co");
  await expect.element(page.getByRole("option", { name: /code/ })).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.element(search).toHaveValue("~/code/");
  await expect.element(page.getByRole("option").first()).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => expect(search.element()).toHaveValue("~/code/alpha/"));
  await expect.element(search).toHaveFocus();
  await expect.element(page.getByRole("option").first()).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(search).not.toBeInTheDocument();
  openCommandPalette({ open: "new-thread-in" });
  await expect.element(search).toHaveFocus();
  await userEvent.type(search, "~/co");
  await expect.element(page.getByRole("option", { name: /code/ })).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.element(search).toHaveValue("~/code/");
  await expect.element(page.getByRole("option").first()).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{ArrowUp}");
  await expect.element(page.getByRole("option").first()).toHaveAttribute("data-highlighted");
  await userEvent.keyboard("{Tab}");
  await expect.element(search).toHaveValue("~/code/");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(search).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(document.querySelector("[data-draft-project-trigger]")?.textContent).toMatch(/^code/),
  );
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Keep this unsent prompt",
  );
});

it("hands the keyboard back to the composer when the picker closes without a choice", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-escape");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The where-line trigger did not render.");
  await userEvent.click(page.elementLocator(trigger));
  const search = page.getByRole("combobox", { name: "Project name or path" });
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-editor"),
  );
});
