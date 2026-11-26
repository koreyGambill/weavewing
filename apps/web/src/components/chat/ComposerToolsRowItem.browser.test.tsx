import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerRow } from "./ComposerRow";
import { useThreadComposerRowItems } from "./threadComposerRowItems";

import "~/index.css";

const environmentId = EnvironmentId.make("environment-row-tools");
const threadRef = { environmentId, threadId: ThreadId.make("thread-row-tools") };

const state = vi.hoisted(() => ({
  providerInstanceId: "claudeAgent",
  capability: true,
  inventory: vi.fn(),
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({
    id: "thread-row-tools",
    providerInstanceId: state.providerInstanceId,
    runtime: { status: "completed" },
    pendingBackgroundTasks: [],
  })) as never,
  useServerConfigs: (() =>
    new Map([
      [
        "environment-row-tools",
        {
          environment: { capabilities: { threadToolOverrides: state.capability } },
          settings: { providerInstances: {} },
        },
      ],
    ])) as never,
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
        permissionAtom: () => Atom.make(true),
      },
      threadMcpServers: Object.assign((target: unknown) => Atom.make(state.inventory(target)), {
        permissionAtom: () => Atom.make(true),
      }) as never,
    },
  };
});

function setup(input: { providerInstanceId?: string; capability?: boolean } = {}) {
  state.providerInstanceId = input.providerInstanceId ?? "claudeAgent";
  state.capability = input.capability ?? true;
  state.inventory.mockReset().mockReturnValue(AsyncResult.success({ servers: [] }));
}

/** The thread view's own row items, after a wide item that crowds a narrow row. */
function ToolsRow(props: { readonly narrow?: boolean }) {
  const threadItems = useThreadComposerRowItems({
    threadRef,
    bookmarksThreadRef: null,
    agents: [{ status: "running" }] as never,
    onOpenSideChat: undefined,
    onRevealBookmark: () => {},
  });
  return (
    <div
      data-slot="composer-shell"
      className={
        props.narrow ? "@container/composer-surface w-80" : "@container/composer-surface w-[40rem]"
      }
    >
      <ComposerRow
        items={[
          ...(props.narrow
            ? [
                {
                  id: "wide",
                  priority: null,
                  renderRowItem: () => <span className="inline-block w-40">Wide item</span>,
                },
              ]
            : []),
          ...threadItems,
        ]}
      />
    </div>
  );
}

const rowItem = (id: string) => document.querySelector(`[data-composer-row-item="${id}"]`);

it("shows Tools after Agents in the row and requests nothing until it opens", async () => {
  setup();
  await using screen = await render(<ToolsRow />);
  const trigger = screen.getByRole("button", { name: /^Tools 7 off\./ });
  await expect.element(trigger).toBeVisible();
  expect(rowItem("tools")?.hasAttribute("data-in-menu")).toBe(false);
  expect(rowItem("agents")?.nextElementSibling).toBe(rowItem("tools"));
  expect(state.inventory).not.toHaveBeenCalled();

  await userEvent.click(trigger);
  await expect.element(page.getByRole("dialog", { name: "Tools for this thread" })).toBeVisible();
  expect(state.inventory).toHaveBeenCalledOnce();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
});

it("leaves whole into the thread menu, which shows its value and opens the same popover", async () => {
  setup();
  await using _screen = await render(<ToolsRow narrow />);
  await vi.waitFor(() => expect(rowItem("tools")?.hasAttribute("data-in-menu")).toBe(true));
  const menuButton = page.getByRole("button", { name: "Thread menu" });
  await userEvent.click(menuButton);
  const menuRow = page.getByRole("menuitem", { name: /Tools/ });
  await expect.element(menuRow).toHaveTextContent("Tools7 off");
  expect(state.inventory).not.toHaveBeenCalled();

  await userEvent.click(menuRow);
  const dialog = page.getByRole("dialog", { name: "Tools for this thread" });
  await expect.element(dialog).toBeVisible();
  // Anchored to ⋯, not to the invisible control the row keeps mounted.
  const anchor = (await menuButton.element()).getBoundingClientRect();
  const popup = (await dialog.element()).getBoundingClientRect();
  expect(popup.bottom <= anchor.top + 1 || popup.top >= anchor.bottom - 1).toBe(true);
  expect(popup.left).toBeLessThan(anchor.right);
  expect(popup.right).toBeGreaterThan(anchor.left);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(menuButton).toHaveFocus();
});

it.each([
  ["a thread off Claude", { providerInstanceId: "codex" }],
  ["a server without per-thread tools", { capability: false }],
] as const)("shows no Tools item for %s", async (_name, input) => {
  setup(input);
  await using _screen = await render(<ToolsRow narrow />);
  await expect.element(page.getByRole("button", { name: /Agents: 1 working/ })).toBeVisible();
  expect(rowItem("tools")).toBeNull();
  // With nothing in it, the thread menu stays hidden.
  expect(document.querySelector("[data-composer-row-menu]")?.hasAttribute("inert")).toBe(true);
});
