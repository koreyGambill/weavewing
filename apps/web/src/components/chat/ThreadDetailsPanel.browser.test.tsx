import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetail,
  ThreadId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const SCRATCH_ROOT = "/home/user/.t3/scratch";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  folder: "",
  pullRequests: [] as unknown[],
  configLoaded: true,
  git: false,
  openLink: vi.fn(),
  openChanges: vi.fn(),
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "project",
          environmentId: "environment",
          title: state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain",
          workspaceRoot: state.workspaceRoot,
          scripts: [],
          repositoryIdentity: state.git
            ? {
                canonicalKey: "github.com/owner/repo",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "https://github.com/owner/repo.git",
                },
                provider: "github",
                owner: "owner",
                name: "repo",
              }
            : null,
        }) as never,
  useProjects: (() => []) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "thread",
          environmentId: "environment",
          projectId: "project",
          worktreePath: state.folder,
          branch: state.git ? "feature" : null,
          pullRequests: state.pullRequests,
        }) as never,
  useServerConfigs: (() =>
    new Map(
      state.configLoaded
        ? [
            [
              EnvironmentId.make("environment"),
              {
                scratchWorkspaceRoot: SCRATCH_ROOT,
                environment: { capabilities: { pullRequests: true } },
              },
            ],
          ]
        : [],
    )) as never,
}));
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const notARepo = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  const gitStatus = Atom.make(
    AsyncResult.success({
      hasPrimaryRemote: true,
      isDefaultRef: false,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 12, deletions: 3 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      isRepo: true,
      refName: "feature",
      pr: {
        number: 7,
        title: "Branch draft",
        url: "https://github.com/owner/repo/pull/7",
        state: "open",
        isDraft: true,
        headRef: "feature",
        baseRef: "main",
      },
    }),
  );
  return {
    ...actual,
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      status: (() => (state.git ? gitStatus : notARepo)) as never,
    },
  };
});

vi.mock(import("~/browser/useOpenLink"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOpenLink: () => state.openLink,
}));

vi.mock(import("~/state/pullRequests"), async (importOriginal) => {
  const actual = await importOriginal();
  const detail = Atom.make(
    AsyncResult.success({
      provider: SourceControlProviderKind.make("github"),
      projectId: ProjectId.make("project"),
      projectTitle: "plain",
      workspaceRoot: "/work/project",
      repository: "owner/repo",
      number: 7,
      title: "Branch draft",
      body: "",
      url: "https://github.com/owner/repo/pull/7",
      author: { login: "author", name: null, avatarUrl: null },
      viewer: "author",
      state: "open",
      isDraft: true,
      mergeability: "mergeable",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      headBranch: "feature",
      baseBranch: "main",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: false, squash: false, rebase: false },
      capabilities: {
        diff: true,
        comment: false,
        search: true,
        actions: ["ready"],
        mergeMethods: [],
        review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
        edit: { changeRequest: true, comment: false },
      },
      viewerPermissions: {
        actions: ["ready"],
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
    } satisfies PullRequestDetail),
  );
  return {
    ...actual,
    pullRequestEnvironment: { ...actual.pullRequestEnvironment, detail: (() => detail) as never },
  };
});

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { PopoverCreateHandle } from "../ui/popover";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";
import { useComposerRowChipItems } from "./threadComposerRowChips";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 27513,
  url: "https://github.com/pingdotgg/t3code/pull/27513",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

function setup(input: {
  workspaceRoot: string;
  folder: string;
  pullRequests?: ThreadPullRequestLink[];
  configLoaded?: boolean;
  git?: boolean;
}) {
  state.git = input.git ?? false;
  state.openLink.mockReset().mockResolvedValue(undefined);
  state.openChanges.mockReset();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, pullRequestLinksOpenInApp: false });
  state.configLoaded = input.configLoaded ?? true;
  state.workspaceRoot = input.workspaceRoot;
  state.folder = input.folder;
  state.pullRequests = input.pullRequests ?? [];
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", true);
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

/** The row's pull request chip, as the composer strip shows it beside the branch. */
function PullRequestChip() {
  const status = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: threadRef.environmentId,
      input: { cwd: state.folder },
    }),
  );
  const chip = useComposerRowChipItems({
    threadRef,
    branch: "feature",
    gitStatus: status.data,
  }).find((item) => item.id === "pull-request");
  return chip && !chip.hidden ? chip.renderRowItem?.() : null;
}

function Panel({
  fixture,
  composerContextAvailable = true,
}: {
  fixture: ReturnType<typeof setup>;
  composerContextAvailable?: boolean;
}) {
  const noop = () => {};
  const scriptResult = async () => ({ ok: true }) as never;
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: placement,
        detailsCardPlacement: placement,
      }}
    >
      {state.git && composerContextAvailable ? (
        <>
          <BranchToolbarBranchSelector
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            envLocked
            startFromOrigin={false}
            onStartFromOriginChange={noop}
          />
          <PullRequestChip />
        </>
      ) : null}
      <ThreadDetailsPanel
        anchor={fixture.anchor}
        handle={fixture.handle}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        projectId={ProjectId.make("project")}
        composerDraftTarget={threadRef}
        worktreePath={state.folder}
        isServerThread
        activeProjectName={state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain"}
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker={false}
        openInShortcutEnabled={false}
        onOpenChanges={state.openChanges}
        gitCwd={state.folder}
        workspaceMutationId={null}
        isGitRepo={state.git}
        envLocked
        availableEnvironments={[]}
        onEnvModeChange={noop}
        envMode="local"
        startFromOrigin={false}
        onStartFromOriginChange={noop}
        onComposerFocusRequest={noop}
        onRunProjectScript={noop}
        onAddProjectScript={scriptResult}
        onUpdateProjectScript={scriptResult}
        onDeleteProjectScript={scriptResult}
        usage={{} as never}
      />
    </ChatCanvasContext>
  );
}

it("offers no git controls in a No project thread, but shows its linked pull request", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("shows a linked pull request in a folder that is not a git repository", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
});

it("offers no Initialize Git before the server config says where No project lives", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    configLoaded: false,
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("offers Ready for a branch-discovered draft in Thread Details with external PR links", async () => {
  using fixture = setup({ workspaceRoot: "/work/project", folder: "/work/project", git: true });
  await using _screen = await render(<Panel fixture={fixture} />);
  const card = page.getByRole("region", { name: "Thread details" });
  await page.getByRole("link", { name: /#7/ }).click();
  expect(state.openLink).toHaveBeenCalledWith(
    "https://github.com/owner/repo/pull/7",
    expect.anything(),
  );
  await expect.element(card.getByRole("button", { name: "Ready", exact: true })).toBeEnabled();
});

it("shows counted Changes in Thread Details when there is no composer strip", async () => {
  using fixture = setup({ workspaceRoot: "/work/project", folder: "/work/project", git: true });
  await using _screen = await render(<Panel fixture={fixture} composerContextAvailable={false} />);
  const card = page.getByRole("region", { name: "Thread details" });
  const changes = card.getByRole("button", { name: /Changes.*\+12.*-3/ });
  await expect.element(changes, { timeout: 2500 }).toBeVisible();
  await changes.click();
  expect(state.openChanges).toHaveBeenCalledOnce();
});
