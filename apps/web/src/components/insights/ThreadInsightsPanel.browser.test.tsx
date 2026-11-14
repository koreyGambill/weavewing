import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  TurnItemId,
  ProviderInstanceId,
  type ThreadInsights,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../state/threadInsights", () => ({ threadInsightsGet: state.query }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
import { ThreadInsightsPanel } from "./ThreadInsightsPanel";

it("filters observed activity and distinguishes known instruction estimates from reported provider totals", async () => {
  state.query.mockReset();
  const threadRef = {
    environmentId: EnvironmentId.make("insights-browser"),
    threadId: ThreadId.make("insights-browser"),
  };
  const runId = RunId.make("run-latest");
  const data: ThreadInsights = {
    threadId: threadRef.threadId,
    selectedRunId: runId,
    runs: [
      { id: RunId.make("run-old"), ordinal: 1, startedAt: "2026-11-06T01:00:00Z" },
      { id: runId, ordinal: 2, startedAt: "2026-11-06T02:00:00Z" },
    ],
    loads: [
      {
        itemId: TurnItemId.make("file"),
        runId,
        at: "2026-11-06T02:00:01Z",
        kind: "file",
        label: "Read settings",
        paths: ["/work/settings.json"],
        toolName: "read_file",
        evidence: "reported",
        status: "completed",
        outputBytes: 1200,
        estimatedOutputTokens: 300,
      },
      {
        itemId: TurnItemId.make("skill"),
        runId,
        at: "2026-11-06T02:00:02Z",
        kind: "skill",
        label: "Read review skill",
        paths: ["/skills/review/SKILL.md"],
        toolName: "exec",
        evidence: "inferred",
        status: "failed",
        outputBytes: null,
        estimatedOutputTokens: null,
      },
    ],
    usage: [
      {
        runId,
        turnId: "turn",
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        at: "2026-11-06T02:00:03Z",
        status: "complete",
        localCommand: false,
        hasSubagents: false,
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 700,
        cacheCreationTokens: 100,
        reasoningTokens: 50,
        otherInputTokens: null,
        otherOutputTokens: null,
      },
    ],
    footprints: [
      {
        threadId: threadRef.threadId,
        runId,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        driver: "claudeAgent",
        model: "test",
        capturedAt: "2026-11-06T02:00:00Z",
        source: "Dispatch snapshot",
        parts: [
          {
            key: "workspace",
            label: "Workspace instructions",
            category: "t3",
            bytes: 400,
            estimatedTokens: 100,
          },
        ],
      },
    ],
    estimateMethod: "UTF-8 bytes / 4, approximate.",
  };
  const firstPoint = data.usage[0];
  if (!firstPoint) throw new Error("Missing usage fixture");
  const history: ThreadInsights = {
    ...data,
    usage: [
      ...data.usage,
      {
        ...firstPoint,
        runId: RunId.make("run-old"),
        turnId: "old-turn",
        ordinal: 2,
        inputTokens: 500,
        outputTokens: 100,
      },
      { ...firstPoint, turnId: "local-command", ordinal: 3, localCommand: true, inputTokens: 9999 },
    ],
  };
  const atom = Atom.make(AsyncResult.success(history)).pipe(Atom.keepAlive);
  state.query.mockReturnValue(atom);
  await using view = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ThreadInsightsPanel threadRef={threadRef} visible mode="loads" />
    </RegistryContext.Provider>,
  );
  await expect.element(page.getByText("settings.json", { exact: true })).toBeVisible();
  await expect.element(page.getByText("/work/settings.json", { exact: true })).not.toBeVisible();
  await page.getByText("settings.json", { exact: true }).click();
  await expect.element(page.getByText("/work/settings.json", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search file and skill activity" }).fill("SKILL.md");
  await expect
    .element(page.getByText("/work/settings.json", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("review / SKILL.md", { exact: true })).toBeVisible();
  await page.getByText("review / SKILL.md", { exact: true }).click();
  await expect.element(page.getByText("/skills/review/SKILL.md", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Unknown", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reported" }).click();
  await expect.element(page.getByText("No activity matches these filters.")).toBeVisible();
  await page.getByRole("combobox", { name: "Inspect run" }).selectOptions("run-old");
  expect(state.query).toHaveBeenLastCalledWith(
    expect.objectContaining({ input: { threadId: threadRef.threadId, runId: "run-old" } }),
  );
  await view.rerender(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ThreadInsightsPanel threadRef={threadRef} visible mode="tokens" />
    </RegistryContext.Provider>,
  );
  await expect
    .element(page.getByRole("figure", { name: "Reported token usage by provider turn" }))
    .toBeVisible();
  await expect
    .element(page.getByText("Provider harness: unknown", { exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "How tokens are counted" }).click();
  await expect.element(page.getByText("Provider harness: unknown", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "How tokens are counted" }).click();
  await expect.element(page.getByText("Workspace instructions", { exact: true })).not.toBeVisible();
  await page.getByText("Instruction estimates · 1 snapshot", { exact: true }).click();
  await expect.element(page.getByText("Workspace instructions", { exact: true })).toBeVisible();
  await expect.element(page.getByText("~100 tokens", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Inspect run" }).selectOptions("all");
  expect(state.query).toHaveBeenLastCalledWith(
    expect.objectContaining({ input: { threadId: threadRef.threadId, allRuns: true } }),
  );
  appAtomRegistry.set(atom, AsyncResult.success({ ...history, selectedRunId: null }));
  await expect.element(page.getByText("1,500", { exact: true })).toBeVisible();
  await page.getByText("Turn details · 3", { exact: true }).click();
  await expect.element(page.getByText("Local command (excluded)", { exact: true })).toBeVisible();
  await page.getByText("Turn 1", { exact: true }).last().click();
  await expect.element(page.getByText("Other input", { exact: true }).first()).toBeVisible();
  appAtomRegistry.set(atom, AsyncResult.success({ ...data, footprints: [] }));
  await expect
    .element(
      page.getByText(
        "No instruction snapshot was captured for this run. Historical payloads cannot be reconstructed reliably.",
      ),
    )
    .toBeVisible();
});
