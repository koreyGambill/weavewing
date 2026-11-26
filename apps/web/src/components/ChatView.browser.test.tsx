import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2Subagent,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type { ReviewDiffPreviewInput } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { environmentContextRecord } from "~/lib/composerContextRecords";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { usePromptStashStore } from "~/promptStashStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useToolSidebarStore } from "../toolSidebarStore";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerAssetUrls,
  answerRpc,
  assistantItem,
  dispatchedCommands,
  emitThreadEvent,
  hasPendingAssetUrl,
  installFakeEnvironment,
  acknowledgePendingCommand,
  rejectPendingCommand,
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../test/render";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

/** Accepts every attachment upload without sending its bytes, until disposed. */
function acceptAttachmentUploads(): Disposable {
  const mint = answerRpc(WS_METHODS.attachmentsCreateUploadUrl, () =>
    Effect.succeed({ attachmentId: "upload-1", relativeUrl: "/upload", expiresAt: 0 }),
  );
  // Sending verifies each ready upload still exists on the server.
  const verify = answerRpc(WS_METHODS.assetsCreateUrl, () =>
    Effect.succeed({ relativeUrl: "/upload-1", expiresAt: 0 }),
  );
  const status = vi.spyOn(XMLHttpRequest.prototype, "status", "get").mockReturnValue(200);
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
    this: XMLHttpRequest,
  ) {
    queueMicrotask(() => this.dispatchEvent(new ProgressEvent("load")));
  });
  return {
    [Symbol.dispose]: () => {
      send.mockRestore();
      status.mockRestore();
      mint[Symbol.dispose]();
      verify[Symbol.dispose]();
    },
  };
}

/** Holds every call to `method` until `release`, then ends it with `end`, until disposed. */
function holdRpc<Input>(method: string, end: Effect.Effect<never, Error>) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Input[] = [];
  const answer = answerRpc(method, (input: Input) => {
    calls.push(input);
    return Effect.promise(() => held).pipe(Effect.andThen(end));
  });
  return { calls, release, [Symbol.dispose]: () => answer[Symbol.dispose]() };
}

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("shows the archived suffix inline and the full history when opened on its own", async () => {
  const source = threadWithHistory("rewind-main", 2);
  const archive = {
    ...threadWithHistory("rewind-archive", 1),
    sideChatOf: source.id,
    contextArchive: { fromRunOrdinal: 1, throughRunOrdinal: 2, splitAfterRunOrdinal: 1 },
    inheritedItems: source.items,
  };
  using _environment = installFakeEnvironment([
    { ...source, items: source.items.slice(0, 2) },
    archive,
  ]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${source.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });

  const prefix = "Answer 0 for rewind-main.";
  const suffix = "Answer 1 for rewind-main.";
  await expect.element(page.getByText(prefix, { exact: false })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Earlier conversation", exact: true }));
  const paneSelector = `[data-side-chat-pane="${archive.id}"]`;
  await vi.waitFor(() => expect(document.querySelector(paneSelector)).not.toBeNull());
  const pane = page.elementLocator(document.querySelector(paneSelector)!);
  await expect.element(pane.getByText(suffix, { exact: false })).toBeVisible();
  await expect
    .element(pane.getByText("Answer 0 for rewind-archive.", { exact: false }))
    .toBeVisible();
  await expect.element(pane.getByText(prefix, { exact: false })).not.toBeInTheDocument();
  await userEvent.click(pane.getByRole("button", { name: "Open full chat" }));
  await vi.waitFor(() => expect(document.querySelector(paneSelector)).toBeNull());
  await expect.element(page.getByText(prefix, { exact: false })).toBeVisible();
  await expect.element(page.getByText(suffix, { exact: false })).toBeVisible();
});

it("a machine chip stashed in one thread restores with its machine in another", async () => {
  const other = threadWithHistory("thread-stash-restore", 1);
  const asking = threadWithQuestion("thread-stash-question", "Which file should change?");
  using _environment = installFakeEnvironment([other, asking]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-stash-machine");
  const machine = environmentContextRecord(EnvironmentId.make("environment-build"), "Build box");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-stash-machine"),
  });
  drafts.setPrompt(draftId, "Deploy on ");
  drafts.addEnvironmentContexts(draftId, [machine]);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const pressStashShortcut = async () => {
    await userEvent.click(editor);
    await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  };
  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  // A draft can't stash until the shell snapshot lists its project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  await pressStashShortcut();
  await vi.waitFor(() => expect(usePromptStashStore.getState().entries).toHaveLength(1));

  // An answer carries no machines, so an open question refuses the restore and keeps the entry.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${asking.id}` });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);

  await router.navigate({ to: `/${ENVIRONMENT_ID}/${other.id}` });
  await expect.element(page.getByText("Answer 0 for thread-stash-restore.")).toBeVisible();
  await pressStashShortcut();

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, other.id))
      ?.environmentContexts,
  ).toEqual([machine]);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.environmentContexts ?? [],
  ).toEqual([]);
});

it("a question that opens while a stashed file is checked keeps a machine stash", async () => {
  const thread = threadWithHistory("thread-stash-late-question", 1);
  const asking = threadWithQuestion("thread-stash-late-question", "Which file should change?");
  const [request] = asking.runtimeRequests ?? [];
  const question = asking.items.at(-1);
  if (!request || !question) throw new Error("threadWithQuestion has no question");
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  usePromptStashStore.getState().stashEntry({
    id: "stash-late-question",
    createdAt: "2026-01-01T00:00:00.000Z",
    prompt: "Deploy on ",
    attachments: [],
    files: [
      {
        id: "file-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        attachmentId: "attachment-notes",
        environmentId: ENVIRONMENT_ID,
      },
    ],
    droppedImageNames: [],
    records: [environmentContextRecord(EnvironmentId.make("environment-build"), "Build box")],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-stash-late-question.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));

  // The question opens while the restore still waits on the server's file check.
  await vi.waitFor(() => expect(hasPendingAssetUrl()).toBe(true));
  await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: question });
  await emitThreadEvent(thread.id, { type: "runtime-request.updated", payload: request });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await answerAssetUrls();

  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);
  usePromptStashStore.getState().takeEntry("stash-late-question");
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("an interrupted image-only first send of a new thread says it may not have been sent", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-image-only-interrupted");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-image-only-interrupted"),
    });
  // A dropped connection interrupts a new thread's launch, which is not resent.
  using launch = holdRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, Effect.interrupt);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _uploads = acceptAttachmentUploads();
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  // The send needs the project, which arrives with the shell snapshot.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([PNG], "shot.png", { type: "image/png" }));
  editor
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  await expect.element(page.getByRole("img", { name: "shot.png" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(launch.calls).toHaveLength(1));
  await userEvent.keyboard("next draft");
  await expect.element(editor).toHaveTextContent("next draft");
  launch.release();

  await expect.element(page.getByText("Message may not have been sent")).toBeVisible();
  await expect.element(editor).toHaveTextContent("next draft");
  // With no text there is nothing to copy.
  expect(page.getByText("Copy message", { exact: true }).query()).toBeNull();
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});

it("retains each thread's diff selection when returning from another thread or Settings", async () => {
  await using viewport = new AsyncDisposableStack();
  const initialSize = { width: window.innerWidth, height: window.innerHeight };
  viewport.defer(() => page.viewport(initialSize.width, initialSize.height));
  // Both the conversation and its diff must be visible during navigation.
  await page.viewport(1100, 800);
  const a = threadWithHistory("diff-selection-a", 1);
  const b = threadWithHistory("diff-selection-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useRightPanelStore.getState().open(aRef, "diff");
  useRightPanelStore.getState().open(bRef, "diff");
  useDiffPanelStore.getState().selectBranchBaseRef(bRef, "origin/release");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  await act(() => useDiffPanelStore.getState().selectGitScope(aRef, "unstaged"));

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, bRef)).toEqual({
    kind: "branch",
    baseRef: "origin/release",
  });
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef)).toEqual({
    kind: "unstaged",
  });

  await act(() => useDiffPanelStore.getState().selectTurn(aRef, a.runs[0]!.id));
  await act(() => router.navigate({ to: "/settings/general" }));
  await expect
    .element(page.getByRole("heading", { name: "Time format", exact: true }))
    .toBeVisible();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef),
  ).toMatchObject({
    kind: "turn",
    turnId: a.runs[0]!.id,
  });
});

it("overlays tools on a narrow tile and dismisses them after closing the mobile sidebar", async () => {
  await using viewport = new AsyncDisposableStack();
  const initialSize = { width: window.innerWidth, height: window.innerHeight };
  viewport.defer(() => page.viewport(initialSize.width, initialSize.height));
  await page.viewport(390, 800);
  useToolSidebarStore.setState({ visible: false, activeTool: null, maximized: false });
  const thread = threadWithHistory("narrow-tools", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "Toggle main sidebar", exact: true }));
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Toggle tools sidebar", exact: true }));
  await expect.element(screen.getByRole("complementary", { name: "Tools sidebar" })).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: `Message ${thread.title}` }))
    .toBeVisible();
  await vi.waitFor(() => {
    const workspace = screen.container.querySelector("[data-thread-tiling]");
    expect(workspace).not.toBeNull();
    expect(workspace!.getBoundingClientRect().width).toBe(390);
  });
  const composer = screen.getByRole("textbox", { name: `Message ${thread.title}` }).element();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  const reachedComposer = vi.fn();
  composer.addEventListener("keydown", reachedComposer, { once: true });
  composer.dispatchEvent(escape);
  expect(reachedComposer).toHaveBeenCalledOnce();
  expect(useToolSidebarStore.getState().visible).toBe(true);
  const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  document.body.dispatchEvent(handled);
  expect(useToolSidebarStore.getState().visible).toBe(true);
  await act(() => useToolSidebarStore.getState().dispatch({ type: "collapse" }));
  await userEvent.click(screen.getByRole("button", { name: "Tile actions", exact: true }));
  await expect.element(page.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  expect(useToolSidebarStore.getState().visible).toBe(true);
  await page.viewport(700, 800);
  await act(() => useToolSidebarStore.getState().dispatch({ type: "select", tool: "calendar" }));
  await expect.element(screen.getByRole("complementary", { name: "Tools sidebar" })).toBeVisible();
  await userEvent.click(
    screen.getByRole("region", { name: "Calendar", exact: true }).getByRole("button", {
      name: "Calendar",
      exact: true,
    }),
  );
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("complementary", { name: "Tools sidebar" }))
    .not.toBeInTheDocument();
  expect(useToolSidebarStore.getState()).toMatchObject({ visible: true, activeTool: null });
  await page.viewport(1100, 800);
  await expect.element(screen.getByRole("complementary", { name: "Tools sidebar" })).toBeVisible();
});

it("a stashed prompt ending in a file chip restores with the chip", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-28338");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-28338"),
  });
  drafts.setPrompt(draftId, "Check [package.json](package.json) ");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const chip = page.getByRole("button", { name: "Preview package.json" });
  await expect.element(chip).toBeVisible();
  // The stash shortcut is a no-op until the shell snapshot lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  await expect.element(chip).not.toBeInTheDocument();
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Check"));
  expect(editor.element().textContent).not.toContain("[package.json](package.json)");
  await expect.element(chip).toBeVisible();
});

it("a rejected send leaves the timeline when a new draft was typed meanwhile", async () => {
  const thread = threadWithHistory("rejected-send", 1);
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Failed prompt{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );
  await expect.element(page.getByText("Failed prompt")).toBeVisible();
  await userEvent.keyboard("Next draft");

  await rejectPendingCommand("Attachment 'sample.png' cannot be sent.");

  await expect.element(page.getByText("Attachment 'sample.png' cannot be sent.")).toBeVisible();
  await expect.element(page.getByText("Failed prompt")).not.toBeInTheDocument();
  expect(editor.element().textContent).toContain("Next draft");
});

it.each(["before receipt", "after reopening"] as const)(
  "stops a submitted turn before its run arrives (%s)",
  async (when) => {
    const thread = threadWithHistory(`stop-submission-${when.replaceAll(" ", "-")}`, 1);
    const other = threadWithHistory("other-thread", 1);
    using _environment = installFakeEnvironment([thread, other], {
      acceptCommands: true,
      threadStop: true,
      holdCommand: (command) => command.type === "message.dispatch",
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("Wrong model{Enter}");
    await vi.waitFor(() =>
      expect(dispatchedCommands().some((command) => command.type === "message.dispatch")).toBe(
        true,
      ),
    );
    const stop = page.getByRole("button", { name: "Stop generation" });
    if (when === "before receipt") {
      await stop.click();
      expect(dispatchedCommands().some((command) => command.type === "thread.stop")).toBe(false);
    }
    await acknowledgePendingCommand();
    if (when === "after reopening") {
      await act(() => router.navigate({ to: `/${ENVIRONMENT_ID}/${other.id}` }));
      await expect.element(page.getByText(`Answer 0 for ${other.id}.`)).toBeVisible();
      await act(() => router.navigate({ to: `/${ENVIRONMENT_ID}/${thread.id}` }));
      await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
      await stop.click();
    }
    await vi.waitFor(() =>
      expect(dispatchedCommands()).toContainEqual(
        expect.objectContaining({ type: "thread.stop", threadId: thread.id }),
      ),
    );
  },
);

it("Enter on an empty prompt resumes an interrupted thread", async () => {
  const history = threadWithHistory("interrupted", 1);
  const interruptedRun = { ...history.runs[0]!, status: "interrupted" as const };
  const thread = { ...history, runs: [interruptedRun] };
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByRole("button", { name: "Resume thread" })).toBeVisible();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ manualContinuationOfRunId: interruptedRun.id }),
    ),
  );
});

it("opening a thread or returning to the window on a touch tablet does not focus the composer", async () => {
  const realMatchMedia = window.matchMedia.bind(window);
  using _touch = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => realMatchMedia(query === "(pointer: coarse)" ? "all" : query));
  const first = threadWithHistory("thread-29469-a", 1);
  const second = threadWithHistory("thread-29469-b", 1);
  using _environment = installFakeEnvironment([first, second]);
  // iPad Pro 11 in landscape: the desktop layout, above max-sm.
  await page.viewport(1194, 834);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  await expect.element(page.getByText(`Answer 0 for ${first.id}.`)).toBeVisible();

  // Fake frames hold the next thread entry's focus frame until the test advances it.
  using _timers = fakeTimers();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: second.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${second.id}.`)).toBeVisible();
  vi.advanceTimersToNextFrame();
  // Focusing the editor raises the on-screen keyboard, which shrinks the page on iPadOS.
  expect(document.activeElement).not.toBe(composer.element());

  // ChatView waits two frames after window focus before refocusing the composer.
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(document.activeElement).not.toBe(composer.element());
});

it("a mounted thread view lets go of the thread structures it has replaced", async () => {
  // Items are shared with the fixture, so a reopen's snapshot also carries the earlier updates.
  const history = threadWithHistory("updated", 3);
  const items = [...history.items];
  const updated = { ...history, items };
  const other = threadWithHistory("other", 3);
  using _environment = installFakeEnvironment([updated, other], { rewindToReply: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const open = async (threadId: ThreadId, text: string) => {
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId },
      }),
    );
    await expect.element(page.getByText(text).first()).toBeVisible();
  };
  const structureAtom = environmentThreadDetails.quietThreadAtom(
    scopeThreadRef(ENVIRONMENT_ID, updated.id),
  );

  // Collect six replacements across three visits to also exercise switching away.
  const shown: Array<WeakRef<object>> = [];
  await open(other.id, "Answer 2 for other.");
  for (let round = 0; round < 6; round++) {
    if (round % 2 === 0) {
      await open(updated.id, round === 0 ? "Answer 2 for updated." : `Update ${round - 1}.`);
    }
    const update = assistantItem(
      updated.id,
      RunId.make("updated-run-2"),
      `updated-update-${round}`,
      6 + round,
      `Update ${round}.`,
    );
    items.push(update);
    await act(() => emitThreadEvent(updated.id, { type: "turn-item.updated", payload: update }));
    await expect.element(page.getByText(`Update ${round}.`)).toBeVisible();
    shown.push(new WeakRef(appAtomRegistry.get(structureAtom)!.projection));
    if (round % 2 === 1) await open(other.id, "Answer 2 for other.");
  }
  await cdp().send("HeapProfiler.collectGarbage");

  // The thread keeps its latest structure, and the timeline may remember the one before it.
  const kept = shown.slice(0, -2).flatMap((structure, round) => (structure.deref() ? [round] : []));
  expect(kept).toEqual([]);
});

it("selecting a side-chat tab focuses that side chat's composer", async () => {
  const parent = threadWithHistory("focus-parent", 1);
  // The shell loaded by the file's first test stays; a family read serves side chats added later.
  const sideChat = (name: string) => ({
    ...threadWithHistory(name, 1),
    sideChatOf: parent.id,
    olderSettled: true as const,
  });
  const side = sideChat("focus-side");
  const otherSide = sideChat("focus-other-side");
  await page.viewport(1400, 900);
  using _environment = installFakeEnvironment([parent, side, otherSide]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  useRightPanelStore.getState().openSideChat(parentRef, otherSide.id);
  useRightPanelStore.getState().openSideChat(parentRef, side.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _focus = { [Symbol.dispose]: startWorkspaceFocus(router) };
  const mainEditor = screen.getByRole("textbox", { name: `Message ${parent.title}`, exact: true });
  const sideEditor = screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true });
  await expect.element(sideEditor).toBeVisible();
  await userEvent.click(mainEditor);
  await userEvent.keyboard("main draft");

  await userEvent.click(screen.getByRole("tab", { name: otherSide.title, exact: true }));
  const otherEditor = screen.getByRole("textbox", {
    name: `Message ${otherSide.title}`,
    exact: true,
  });
  await expect.element(otherEditor).toHaveFocus();
  await userEvent.keyboard("other draft");
  await expect.element(otherEditor).toHaveTextContent("other draft");

  await userEvent.click(screen.getByRole("tab", { name: side.title, exact: true }));
  await expect.element(sideEditor).toHaveFocus();
  await expect.element(mainEditor).toHaveTextContent("main draft");
});

it("preserves chat width, details visibility and focus as the tile resizes", async () => {
  await import("~/index.css");
  await using viewport = new AsyncDisposableStack();
  const initial = { width: window.innerWidth, height: window.innerHeight };
  viewport.defer(() => page.viewport(initial.width, initial.height));
  await page.viewport(1560, 860);
  const thread = threadWithHistory("responsive-details", 3);
  using _environment = installFakeEnvironment([thread]);
  useRightPanelStore
    .getState()
    .setThreadPanelOpen(scopeThreadRef(ENVIRONMENT_ID, thread.id), "inline", true);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const answer = page.getByText(`Answer 0 for ${thread.id}.`);
  await expect.element(answer).toBeVisible();
  const tile = document.querySelector<HTMLElement>("[data-chat-canvas]")!;
  const composer = document.querySelector<HTMLElement>("[data-chat-composer-stack]")!;
  const resize = async (width: number, composerWidth: number) => {
    tile.style.width = `${width}px`;
    tile.style.flex = "none";
    await vi.waitFor(() => {
      expect(tile.clientWidth).toBe(width);
      expect(tile.querySelector("[data-thread-details-panel=inline]")).not.toBeNull();
      expect(composer.clientWidth).toBe(composerWidth);
    });
  };
  await resize(1300, 736);
  const control = tile.querySelector<HTMLButtonElement>(
    "[data-thread-details-card] button:not(:disabled)",
  )!;
  control.focus();
  await resize(1050, 736);
  expect(document.activeElement).toBe(control);
  await resize(500, 476);
  expect(document.activeElement).toBe(control);
  await resize(1300, 736);
  await page.getByRole("button", { name: "Toggle thread details panel" }).first().click();
  tile.style.width = "1050px";
  await vi.waitFor(() => {
    expect(tile.querySelector("[data-thread-details-panel]")).toBeNull();
    expect(composer.clientWidth).toBe(736);
  });
});

it("shows agent counts in the row under the composer and agents in Thread Details", async () => {
  await import("~/index.css");
  await using viewport = new AsyncDisposableStack();
  const initial = { width: window.innerWidth, height: window.innerHeight };
  viewport.defer(() => page.viewport(initial.width, initial.height));
  await page.viewport(1560, 860);

  const thread = threadWithHistory("workspace-actions", 1);
  const child = {
    ...threadWithHistory("workspace-side-chat", 1),
    sideChatOf: thread.id,
  };
  using _environment = installFakeEnvironment([thread, child]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const card = page.getByRole("region", { name: "Thread details" });
  await expect.element(card).not.toBeInTheDocument();

  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  for (const status of ["running", "failed", "completed"] as const) {
    const agent = {
      id: NodeId.make(`fixture-${status}`),
      threadId: thread.id,
      runId: null,
      parentNodeId: NodeId.make("fixture-parent"),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Check the composer.",
      title: `Fixture ${status} agent`,
      model: null,
      status,
      result: null,
      startedAt: now,
      completedAt: status === "running" ? null : now,
      updatedAt: now,
    } satisfies OrchestrationV2Subagent;
    await act(() => emitThreadEvent(thread.id, { type: "subagent.updated", payload: agent }));
  }
  const lineageControl = page.getByRole("button", {
    name: "Agents: 1 working, 1 failed, 1 done",
  });
  await expect.element(lineageControl).toHaveTextContent("1 working");
  await lineageControl.click();
  const lineage = page.getByRole("dialog", { name: "Agents" });
  const agent = lineage.getByRole("button", { name: /Fixture running agent/ });
  await agent.click();
  await expect.element(lineage.getByText("Check the composer.")).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(lineage, { timeout: 2500 }).not.toBeInTheDocument();
  await page.viewport(690, 860);
  await lineageControl.click();
  await expect
    .element(lineage.getByRole("button", { name: /Fixture running agent/ }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "Toggle thread details panel" }).first().click();
  await expect.element(card).toBeVisible();
  await expect.element(card.getByRole("button", { name: /Fixture running agent/ })).toBeVisible();
  await expect.element(card.getByRole("button", { name: /Change folder/ })).not.toBeInTheDocument();
});

it("opens the agents list and the thread menu's entries by keyboard, returning focus", async () => {
  await import("~/index.css");
  await using viewport = new AsyncDisposableStack();
  const initial = { width: window.innerWidth, height: window.innerHeight };
  viewport.defer(() => page.viewport(initial.width, initial.height));
  await page.viewport(1400, 860);

  const thread = {
    ...threadWithHistory("row-keyboard", 1),
    olderSettled: true as const,
    worktreePath: "/workspace/row-keyboard",
  };
  using _environment = installFakeEnvironment([thread], {
    vcsStatus: {
      _tag: "snapshot",
      local: {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: true,
        refName: "feature/row-under-the-composer-keyboard",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      },
      remote: null,
    },
  });
  using _bookmarks = answerRpc(WS_METHODS.messageFollowUpsList, () =>
    Effect.succeed([
      {
        threadId: thread.id,
        threadTitle: thread.title,
        messageId: MessageId.make("row-keyboard-bookmark"),
        role: "assistant" as const,
        todo: false,
        excerpt: "Bookmarked reply",
        flaggedAt: "2026-01-01T00:00:00.000Z",
        doneAt: null,
      },
    ]),
  );
  using _refs = answerRpc(WS_METHODS.vcsListRefs, () =>
    Effect.succeed({
      refs: [
        {
          name: "feature/row-under-the-composer-keyboard",
          current: true,
          isDefault: false,
          worktreePath: null,
        },
      ],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 1,
    }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  await act(() =>
    emitThreadEvent(thread.id, {
      type: "subagent.updated",
      payload: {
        id: NodeId.make("row-keyboard-agent"),
        threadId: thread.id,
        runId: null,
        parentNodeId: NodeId.make("row-keyboard-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Review the row.",
        title: "Row reviewer",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      } satisfies OrchestrationV2Subagent,
    }),
  );

  const agents = page.getByRole("button", { name: "Agents: 1 working" });
  (await agents.element()).focus();
  await userEvent.keyboard("{Enter}");
  const agentsList = page.getByRole("dialog", { name: "Agents" });
  await expect.element(agentsList.getByRole("button", { name: /Row reviewer/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(agentsList).not.toBeInTheDocument();
  await expect.element(agents).toHaveFocus();

  const menuButton = page.getByRole("button", { name: "Thread menu" });
  (await menuButton.element()).focus();
  await userEvent.keyboard("{Enter}");
  const menu = page.getByRole("menu");
  await expect.element(menu.getByRole("menuitem", { name: /bookmark/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(menuButton).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(menu.getByRole("menuitem", { name: /bookmark/ })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(menu.getByRole("menuitem", { name: /bookmark/ })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const bookmarks = page.getByRole("dialog", { name: "Bookmarks" });
  await expect.element(bookmarks.getByText("Bookmarked reply")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(bookmarks).not.toBeInTheDocument();
  await expect.element(menuButton).toHaveFocus();

  // Narrow enough that the branch leaves the row for the menu.
  await page.viewport(390, 860);
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-composer-row-item="branch"][data-in-menu]'),
    ).not.toBeNull(),
  );
  (await menuButton.element()).focus();
  await userEvent.keyboard("{Enter}");
  // The menu lists items that left the row before its own entries, and opens on the first.
  // The thread's metadata still says main; the row names the checkout's ref, as the picker does.
  const branchRow = menu.getByRole("menuitem", {
    name: /^feature\/row-under-the-composer-keyboard\s*Branch$/,
  });
  await expect.element(branchRow).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const branchPicker = page.getByRole("listbox");
  await expect.element(branchPicker).toBeVisible();
  const menuRect = (await menuButton.element()).getBoundingClientRect();
  const pickerRect = (await branchPicker.element()).getBoundingClientRect();
  expect(pickerRect.bottom).toBeLessThanOrEqual(menuRect.top);
  await userEvent.keyboard("{Escape}");
  await expect.element(branchPicker).not.toBeInTheDocument();
  await expect.element(menuButton).toHaveFocus();
});

it("moves the branch into the thread menu and back across widths, keeping the location inside its box", async () => {
  await import("~/index.css");
  await using viewport = new AsyncDisposableStack();
  const initial = { width: window.innerWidth, height: window.innerHeight };
  viewport.defer(() => page.viewport(initial.width, initial.height));
  await page.viewport(1280, 860);

  // A 16-character last segment keeps the whole name as the truncation tail.
  const thread = {
    ...threadWithHistory("row-sweep", 1),
    olderSettled: true as const,
    worktreePath: "/workspace/webhook-retry-xy",
  };
  using _environment = installFakeEnvironment([thread], {
    vcsStatus: {
      _tag: "snapshot",
      local: {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: true,
        refName: "feature/row-under-the-composer-sweep",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      },
      remote: null,
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const branchInMenu = () =>
    document.querySelector('[data-composer-row-item="branch"][data-in-menu]') !== null;
  const locationOverflow = () => {
    const item = document.querySelector<HTMLElement>('[data-composer-row-item="location"]');
    const label = item?.querySelector<HTMLElement>("[data-composer-label]");
    if (!label) return 0;
    const box = label.getBoundingClientRect();
    return Math.max(
      0,
      ...Array.from(label.querySelectorAll<HTMLElement>("span"), (span) =>
        span.getBoundingClientRect().width === 0
          ? 0
          : span.getBoundingClientRect().right - box.right,
      ),
    );
  };
  await vi.waitFor(() => expect(branchInMenu()).toBe(false));

  // The reviewer's sweep: narrow until the branch leaves, then widen until it returns.
  for (const width of [
    1280, 980, 760, 640, 600, 580, 560, 530, 500, 480, 420, 390, 360, 320, 280,
  ]) {
    await page.viewport(width, 860);
    if (width <= 390) await vi.waitFor(() => expect(branchInMenu()).toBe(true));
    if (width >= 320 && width <= 390) {
      await vi.waitFor(() => expect(locationOverflow()).toBeLessThanOrEqual(0.5));
    }
  }
  for (const width of [320, 390, 560, 980, 1280]) {
    await page.viewport(width, 860);
    if (width >= 980) await vi.waitFor(() => expect(branchInMenu()).toBe(false));
  }
});

it("uses the remembered base and whitespace-filtered Diff counts beside the branch", async () => {
  await import("~/index.css");
  await using viewport = new AsyncDisposableStack();
  const initial = { width: window.innerWidth, height: window.innerHeight };
  viewport.defer(() => page.viewport(initial.width, initial.height));
  await page.viewport(1400, 860);

  const thread = {
    ...threadWithHistory("branch-counts", 1),
    olderSettled: true as const,
    worktreePath: "/workspace/branch-counts",
  };
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  using _environment = installFakeEnvironment([thread], {
    vcsStatus: {
      _tag: "snapshot",
      local: {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/app.ts", insertions: 12, deletions: 3 }],
          insertions: 12,
          deletions: 3,
        },
      },
      remote: null,
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    diffIgnoreWhitespace: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "origin/stable");
  useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged");
  const branchPreview = vi.fn((input: ReviewDiffPreviewInput) =>
    Effect.succeed({
      cwd: input.cwd,
      generatedAt: DateTime.makeUnsafe("2026-03-17T19:12:28.000Z"),
      sources: [
        {
          id: "branch",
          kind: "branch-range",
          title: "Changes",
          baseRef: input.baseRef ?? null,
          headRef: "main",
          diff: "",
          diffHash: "filtered-diff",
          truncated: false,
          patchesDeferred: true,
          files: [{ path: "src/app.ts", previousPath: null, additions: 2, deletions: 1 }],
        },
      ],
    }),
  );
  using _branchPreview = answerRpc(WS_METHODS.reviewGetDiffPreview, branchPreview);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const counts = page.getByRole("button", { name: "Changes: 2 additions, 1 deletions" });
  await expect.element(counts, { timeout: 3000 }).toBeVisible();
  expect(branchPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sourceKind: "branch-range",
      baseRef: "origin/stable",
      ignoreWhitespace: true,
      metadataOnly: true,
    }),
  );
  const metadataRequests = () =>
    branchPreview.mock.calls.filter(([input]) => input.metadataOnly === true);
  expect(metadataRequests()).toHaveLength(1);
  await counts.click();
  await expect
    .element(page.getByRole("tab", { name: "Diff", exact: true }), { timeout: 2500 })
    .toBeVisible();
  await expect
    .element(page.getByText("origin/stable", { exact: true }).first(), { timeout: 2500 })
    .toBeVisible();
  await expect
    .element(page.getByRole("group", { name: "2 additions, 1 deletions", exact: true }).first(), {
      timeout: 2500,
    })
    .toBeVisible();
  expect(metadataRequests()).toHaveLength(1);
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
  ).toEqual({ kind: "branch", baseRef: "origin/stable" });
});
