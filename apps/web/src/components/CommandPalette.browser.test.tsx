import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
  delegatedUnderParent: new Set<string>() as ReadonlySet<string>,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
  useDelegatedUnderParent: () => entities.delegatedUnderParent,
}));

vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () =>
    entities.threads[0]?.environmentId ?? entities.projects[0]?.environmentId ?? "local",
  useEnvironments: () => ({
    environments: [
      ...new Set([
        "local",
        ...entities.threads.map((thread) => thread.environmentId),
        ...entities.projects.map((project) => project.environmentId),
      ]),
    ].map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: "connected" },
      serverConfig: null,
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
    })),
  }),
  useEnvironmentProviders: () => new Map(),
}));

function setup(state: Partial<typeof entities> = {}) {
  // Earlier browser test files share this origin's localStorage; a remembered project
  // that is not listed here hides the default "New thread in <project>" row.
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
  entities.delegatedUnderParent = state.delegatedUnderParent ?? new Set();
}

describe("CommandPalette open intents", () => {
  it("drags a searched thread into the current composer without navigating", async () => {
    const environmentId = EnvironmentId.make("remote");
    const threadId = ThreadId.make("dragged-thread");
    setup({
      threads: [makeThreadFixture({ environmentId, id: threadId, title: "Drag this thread" })],
    });
    const onDrop = vi.fn();
    await using screen = await render(
      <CommandPalette>
        <div
          data-thread-context-drop="true"
          ref={(node) => {
            node?.addEventListener("t3-thread-context-drop", onDrop);
          }}
          style={{ position: "fixed", bottom: 0, width: 300, height: 100 }}
        >
          Composer
        </div>
      </CommandPalette>,
    );
    const pathname = screen.router?.state.location.pathname;
    openCommandPalette({ query: "Drag this thread" });
    const row = page.getByRole("option", { name: /Drag this thread/ });
    await expect.element(row).toBeVisible();
    const bounds = row.element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    await act(() => {
      row.element().dispatchEvent(pointer("pointerdown", bounds.x + 20, bounds.y + 10));
      document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 20));
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    await act(() => {
      document.dispatchEvent(pointer("pointermove", 50, window.innerHeight - 30));
      document.dispatchEvent(pointer("pointerup", 50, window.innerHeight - 30));
    });
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual([
      { environmentId, threadId, title: "Drag this thread" },
    ]);
    expect(screen.router?.state.location.pathname).toBe(pathname);
  });

  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect
      .element(page.getByRole("combobox", { name: "Project name or path" }))
      .toHaveFocus();
  });

  it("opens the shared project picker from the root list", async () => {
    const environmentId = EnvironmentId.make("local");
    const project = (id: string, title: string): Project => ({
      id: ProjectId.make(id),
      environmentId,
      title,
      workspaceRoot: `/work/${id}`,
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    });
    const acme = project("acme", "Acme");
    using storage = new DisposableStack();
    const previousProject = localStorage.getItem(LAST_USED_PROJECT_STORAGE_KEY);
    storage.defer(() => {
      if (previousProject === null) localStorage.removeItem(LAST_USED_PROJECT_STORAGE_KEY);
      else localStorage.setItem(LAST_USED_PROJECT_STORAGE_KEY, previousProject);
    });
    localStorage.setItem(
      LAST_USED_PROJECT_STORAGE_KEY,
      JSON.stringify(scopedProjectKey({ environmentId, projectId: acme.id })),
    );
    setup({
      projects: [acme, project("beta", "Beta"), project("gamma", "Gamma")],
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    await expect.element(page.getByPlaceholder("Search commands...")).toHaveFocus();
    await expect
      .element(page.getByRole("option", { name: /^New thread in Acme/ }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: /^New thread in\.\.\./ }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByRole("combobox", { name: "Project name or path" }))
      .toHaveFocus();
    await expect
      .element(page.getByRole("button", { name: "All machines", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /^Acme/ }))
      .toHaveAttribute("data-selected");
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: /^Beta/ }))
      .toHaveAttribute("data-highlighted");
    await expect
      .element(page.getByRole("option", { name: /^Acme/ }))
      .not.toHaveAttribute("data-highlighted");
  });

  it("separates commands from thread search and focuses its query", async () => {
    setup({
      threads: [
        makeThreadFixture({ environmentId: EnvironmentId.make("local"), title: "Acme context" }),
      ],
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette();
    await page.getByPlaceholder("Search commands...").fill("acme");
    await expect
      .element(page.getByRole("option", { name: /Acme context/ }))
      .not.toBeInTheDocument();
    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search thread messages and titles…");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
    await expect.element(page.getByRole("option", { name: /Acme context/ })).toBeVisible();
  });
});
