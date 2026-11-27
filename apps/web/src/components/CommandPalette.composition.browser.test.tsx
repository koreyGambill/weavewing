import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import type { Project } from "../types";
import { act, render } from "../../test/render";
import { dispatchCommandPalette } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";
import { waitingThreadsAtom } from "./waiting/threadList/waitingOnYou";
import { NO_WAITING_THREADS } from "./waiting/threadList/waitingThreads.logic";

const scopes = vi.hoisted(() => ({
  denied: undefined as string | undefined,
  sourceControl: undefined as unknown,
  composerFocus: undefined as (() => void) | undefined,
  projects: [] as ReadonlyArray<Project>,
}));
const setup = (deniedScope?: string, sourceControl?: unknown) => {
  scopes.denied = deniedScope;
  scopes.sourceControl = sourceControl;
  scopes.composerFocus = undefined;
  scopes.projects = [];
};
const githubAvailable = {
  versionControlSystems: [],
  sourceControlProviders: [
    {
      kind: "github",
      label: "GitHub",
      status: "available",
      version: { _tag: "None" },
      installHint: "Install GitHub CLI",
      detail: { _tag: "None" },
      auth: {
        status: "authenticated",
        account: { _tag: "Some", value: "demo" },
        host: { _tag: "None" },
        detail: { _tag: "None" },
      },
    },
  ],
};

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === primaryServerKeybindingsAtom
      ? DEFAULT_RESOLVED_KEYBINDINGS
      : atom === waitingThreadsAtom
        ? NO_WAITING_THREADS
        : [],
}));
vi.mock("../composerHandleContext", async (original) => {
  const actual = await original<typeof import("../composerHandleContext")>();
  return {
    ...actual,
    useComposerHandleContext: () => {
      const ref = actual.useComposerHandleContext();
      return scopes.composerFocus ? { current: { focusAtEnd: scopes.composerFocus } } : ref;
    },
  };
});
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  getRenderedAppearance: () => "light",
  subscribeRenderedAppearance: () => () => {},
  useTheme: () => ({ theme: "t3-chat", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateEnvironmentSettings: () => () => undefined,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    defaultPlace: () => ({ kind: "none" }),
    defaultPlaceLabel: () => null,
    startDefaultPlace: async () => false,
  }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    handleNewThread: async () => undefined,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  // The add-project destination step starts a clone and follows its project id.
  useAtomCommand: () => async () => ({ _tag: "Success", value: { projectId: "project-cloned" } }),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
          newProjectsRoot: "/workspace/",
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => scopes.projects,
  useThreadShells: () => [],
  useVisibleThreadShells: () => [],
  useHiddenThreadKeys: () => new Set(),
  useAnyEnvironmentHiding: () => false,
  useEnvironmentThreadRefs: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: async () => undefined,
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: unknown, query: string) => ({
    matches: [],
    query,
    isPending: false,
  }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: (_environmentId: unknown, scope: string) => scope !== scopes.denied,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: scopes.sourceControl, isLoading: false }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

it("opens conversation import from the command palette", async () => {
  await using screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette());
  await page.getByRole("combobox").fill("claude sessions");
  await page.getByText("Import conversations", { exact: true }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/welcome"));
  await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
});

// The real palette and Base UI input must agree that confirming composition is typing.
describe.each(["repository", "folder", "destination"] as const)("add-project %s", (step) => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input during composition: %j", async (composition) => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(step === "folder" ? "Local folder" : "Git URL", { exact: true }).click();
    const input = () => page.getByRole("combobox");
    if (step === "destination") {
      await input().fill("https://example.com/team/project.git");
      await userEvent.keyboard("{Enter}");
    }
    const value = step === "repository" ? "https://example.com/team/計画.git" : "/workspace/計画";
    await input().fill(value);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    await act(() => input().element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input()).toHaveValue(value);
    if (step === "repository") {
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue("/workspace/計画");
    } else {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
  });
});

it.each([
  { step: "folder", source: "Local folder", keys: "", description: /^(?!.*(Ctrl|⌘)).*Add.*Enter/ },
  {
    step: "highlighted folder",
    source: "Local folder",
    keys: "{ArrowDown}",
    description: /Add.*(Ctrl|⌘) Enter/,
  },
  { step: "repository", source: "Git URL", keys: "", description: /Continue.*Enter/ },
  { step: "new project", source: "New project", keys: "", description: /Create.*Enter/ },
  {
    step: "permission-blocked folder",
    source: "Local folder",
    keys: "",
    deniedScope: AuthOrchestrationOperateScope,
    description: "This connection cannot add projects.",
  },
  {
    step: "permission-blocked destination",
    source: "Git URL",
    keys: "https://example.com/team/project.git{Enter}",
    deniedScope: AuthSourceControlWriteScope,
    description: "This connection needs permission to write source control and add projects.",
  },
])(
  "tells screen readers how to submit the $step step",
  async ({ source, keys, deniedScope, description }) => {
    setup(deniedScope);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(source, { exact: true }).click();
    if (keys) await userEvent.keyboard(keys);
    await expect.element(page.getByRole("combobox")).toHaveAccessibleDescription(description);
  },
);

it("keeps the caret in place when an edit briefly makes the folder path not a path", async () => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("Local folder", { exact: true }).click();
  const input = () => page.getByRole("combobox");
  await input().fill("/workspace/project");
  await userEvent.keyboard("{Home}{ArrowRight}{Backspace}");
  await expect.element(input()).toHaveValue("workspace/project");
  await userEvent.keyboard("/");
  await expect.element(input()).toHaveValue("/workspace/project");
  await userEvent.keyboard("w");
  await expect.element(input()).toHaveValue("/wworkspace/project");
});

it.each([
  { flow: "Git URL", value: "https://github.com/pingdotgg/t3code.git", submit: "Continue (Enter)" },
  { flow: "New project", value: "demo-tab-order", submit: /^Create \(/ },
])("moves focus from the $flow input to its enabled submit button on Tab", async (step) => {
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText(step.flow, { exact: true }).click();
  const input = page.getByRole("combobox");
  await input.fill(step.value);
  const submit = page.getByRole("button", { name: step.submit });
  await expect.element(submit).toBeEnabled();
  await userEvent.keyboard("{Tab}");
  await expect.element(submit).toHaveFocus();
});

it("tells screen readers whether a new project will be published", async () => {
  setup(undefined, githubAvailable);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("New project", { exact: true }).click();
  await page.getByRole("combobox").fill("demo-project");
  const option = page.getByRole("option", { name: /Create private repository/ });
  await expect.element(option).toHaveAttribute("aria-checked", "false");
  await option.click();
  await expect.element(option).toHaveAttribute("aria-checked", "true");
});

it("keeps the query across search tabs and restores input focus", async () => {
  setup();
  scopes.projects = Array.from({ length: 11 }, (_, index) => ({
    id: ProjectId.make(`project-${index}`),
    environmentId: EnvironmentId.make("local"),
    title: `Project ${index}`,
    workspaceRoot: `/workspace/${index}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => dispatchCommandPalette({ _tag: "ToggleMode", mode: "search" }));
  await page.getByRole("combobox").fill("token refresh");
  await userEvent.keyboard("{Tab}");
  await expect
    .element(page.getByRole("tab", { name: "Projects", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("combobox")).toHaveValue("token refresh");
  await expect.element(page.getByRole("combobox")).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect
    .element(page.getByRole("tab", { name: "Files", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("combobox")).toHaveValue("token refresh");
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect
    .element(page.getByRole("tab", { name: "Projects", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await page.getByRole("combobox").fill("");
  await act(() => page.getByRole("button", { name: "Show more ▸" }).element().focus());
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("combobox")).toHaveFocus();
  await userEvent.keyboard("{Control>}3{/Control}");
  await expect
    .element(page.getByRole("tab", { name: "Files", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Search", exact: true }))
    .not.toBeInTheDocument();
});

it("returns focus to the terminal after dismissing search or commands", async () => {
  setup();
  scopes.composerFocus = () => {
    document.querySelector<HTMLButtonElement>("[data-composer-fixture]")?.focus();
  };
  await using _screen = await render(
    <CommandPalette>
      <div data-terminal-owner>
        <textarea aria-label="Terminal input" />
      </div>
      <button data-composer-fixture>Composer</button>
    </CommandPalette>,
  );
  const terminal = page.getByRole("textbox", { name: "Terminal input" });
  for (const mode of ["search", "command"] as const) {
    await terminal.click();
    await act(() => dispatchCommandPalette({ _tag: "ToggleMode", mode }));
    await expect.element(page.getByRole("combobox")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(terminal).toHaveFocus();
  }
});
