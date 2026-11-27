import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture repositories need plain git.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture repositories need a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture repositories need a temp folder.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  DevelopmentEnvironmentLifecycleError,
  EnvironmentId,
  type OrchestrationV2DevelopmentEnvironmentUsage,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  type ScheduledTask,
  ScheduledTaskId,
  ThreadId,
  XwingEnvironmentId,
  XwingEnvironmentNotFoundError,
  type XwingHold,
  XwingOperationFailedError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as XwingEnvironments from "../xwing/XwingEnvironments.ts";
import * as XwingOperations from "../xwing/XwingOperations.ts";
import * as DevelopmentEnvironmentHolds from "./DevelopmentEnvironmentHolds.ts";
import * as DevelopmentEnvironmentLifecycle from "./DevelopmentEnvironmentLifecycle.ts";

const ID = XwingEnvironmentId.make("c838284042dc51de");
const ROOT = "/home/dev/.xwing/envs/7";
const SERVER = EnvironmentId.make("server-1");
const OWNER = DevelopmentEnvironmentHolds.holdOwner(SERVER);
const PROJECT = ProjectId.make("project-1");
const SECRET = "token=hunter2";
const NOW = DateTime.makeUnsafe("2026-11-07T12:00:00Z");

interface ThreadFixture {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly settled?: boolean;
  readonly archived?: boolean;
  readonly runStatus?: string;
  readonly background?: boolean;
  readonly terminal?: boolean;
  readonly linked?: boolean;
  readonly released?: boolean;
}

/** Xwing's side as the CLI behaves: holds block deletion, dirty work blocks without discard. */
const makeXwing = (initial: { readonly dirty?: boolean; readonly holds?: Array<XwingHold> }) => {
  const state = {
    holds: [...(initial.holds ?? [])],
    dirty: initial.dirty ?? false,
    deleted: false,
    archived: false,
    calls: [] as Array<string>,
    attachFailures: 0,
    refuseDelete: false,
    environments: [] as Array<{ name: string; sourcePaths: Array<string> }>,
    attachBases: [] as Array<string | undefined>,
    // Real Xwing creates a worktree on attach and removes it on delete, keeping the branch.
    onAttach: undefined as
      | ((input: {
          readonly sourcePath: string;
          readonly branch: string;
          readonly base?: string | undefined;
        }) => void)
      | undefined,
    onDelete: undefined as (() => void) | undefined,
  };
  const blockers = () => [
    ...state.holds.map(
      (hold) =>
        `held by ${hold.owner} ${hold.key} ("${hold.label}"); release with xwing env hold release`,
    ),
    ...(state.dirty ? ["app has uncommitted or untracked work; use --discard-work"] : []),
  ];
  const failed = (operation: "attachRepository" | "delete", category: "blocked" | "baseNotFound") =>
    new XwingOperationFailedError({
      operation,
      category,
      environmentId: ID,
      exitCode: 1,
      blockers: operation === "delete" ? blockers() : undefined,
      cause: new Error(`fatal: remote https://user@example.com ${SECRET}`),
    });
  const operations = Layer.mock(XwingOperations.XwingOperations)({
    startApp: () =>
      Effect.fail(
        new XwingOperationFailedError({
          operation: "startApp",
          category: "failed",
          environmentId: ID,
          exitCode: 1,
          diagnostics: "error: fixture app could not start",
          cause: new Error("stderr"),
        }),
      ),
    create: (input) =>
      Effect.sync(() => {
        state.calls.push(`create ${input.name}`);
        state.environments.push({ name: input.name, sourcePaths: [] });
        return {
          id: ID,
          number: 7,
          name: input.name,
          rootPath: ROOT,
          createdAt: "now",
        };
      }),
    attachRepository: (input) =>
      Effect.suspend(() => {
        state.calls.push(`attach ${input.sourcePath} ${input.branch}`);
        state.attachBases.push(input.base);
        if (state.attachFailures > 0) {
          state.attachFailures -= 1;
          return Effect.fail(failed("attachRepository", "baseNotFound"));
        }
        state.environments.at(-1)?.sourcePaths.push(input.sourcePath);
        state.onAttach?.(input);
        return Effect.succeed({
          environmentId: ID,
          name: "app",
          path: `${ROOT}/app`,
          branch: input.branch,
          created: true,
          stale: false,
          dependencies: [],
          dependencyWarnings: [],
        });
      }),
    previewCleanup: () =>
      Effect.sync(() => ({
        environmentId: ID,
        number: 7,
        name: "space name",
        status: "ready",
        rootPath: ROOT,
        worktrees: [
          {
            name: "app",
            path: `${ROOT}/app`,
            dirty: state.dirty,
            untracked: false,
            ignored: false,
          },
        ],
        holds: [...state.holds],
        blockers: blockers(),
        retainedPaths: [`/home/dev/.xwing/runs/${ID}`],
        deletable: blockers().length === 0,
      })),
    registerHold: (input) =>
      Effect.sync(() => {
        state.calls.push(`register ${input.owner} ${input.key}`);
        const exists = state.holds.some(
          (hold) => hold.owner === input.owner && hold.key === input.key,
        );
        const hold = {
          environmentId: ID,
          owner: input.owner,
          key: input.key,
          label: input.label,
          detail: input.detail,
          createdAt: "now",
          updatedAt: "now",
        };
        if (!exists) state.holds.push(hold);
        return {
          hold: { ...hold, environmentStatus: "active" as const },
          result: exists ? ("unchanged" as const) : ("created" as const),
        };
      }),
    releaseHold: (input) =>
      Effect.sync(() => {
        state.calls.push(`release ${input.owner} ${input.key}`);
        state.holds = state.holds.filter(
          (hold) => !(hold.owner === input.owner && hold.key === input.key),
        );
        return {
          environmentId: ID,
          owner: input.owner,
          key: input.key,
          environmentStatus: "active" as const,
          result: "released" as const,
        };
      }),
    archive: () =>
      Effect.suspend(() => {
        state.calls.push("archive");
        if (state.refuseDelete || blockers().length > 0)
          return Effect.fail(failed("delete", "blocked"));
        state.archived = true;
        return Effect.succeed({
          environmentId: ID,
          outcome: "archived" as const,
          archivePath: "/home/dev/.xwing/archives/7",
        });
      }),
    delete: () =>
      Effect.suspend(() => {
        state.calls.push("delete");
        if (state.refuseDelete || blockers().length > 0) {
          return Effect.fail(failed("delete", "blocked"));
        }
        state.deleted = true;
        state.environments.pop();
        state.onDelete?.();
        return Effect.succeed({
          environmentId: ID,
          outcome: "deleted" as const,
          removedWorktrees: [`${ROOT}/app`],
          retainedPaths: [`/home/dev/.xwing/runs/${ID}`],
          stoppedApplications: [{ id: "app-1", name: "web", status: "stopped" }],
        });
      }),
  });
  return { state, operations };
};

const hold = (owner: string, key: string, label = "work"): XwingHold => ({
  environmentId: ID,
  owner,
  key,
  label,
  createdAt: "now",
  updatedAt: "now",
});

const bindingHold = (threadId: string, period: string) =>
  hold(OWNER, DevelopmentEnvironmentHolds.holdKey({ threadId, period }), `T3 Code: ${threadId}`);

const records = (fixture: ThreadFixture) =>
  ({
    thread: {
      id: ThreadId.make(fixture.id),
      projectId: PROJECT,
      title: `Thread ${fixture.id}`,
      worktreePath: fixture.worktreePath,
      linkedDevelopmentEnvironments: fixture.linked
        ? [
            {
              xwingEnvironmentId: ID,
              repositorySource: "/home/dev/src/app",
              checkoutPath: `${ROOT}/app`,
              number: 7,
              name: "space name",
              selectedAt: NOW,
              ...(fixture.released ? { releasedAt: NOW } : {}),
            },
          ]
        : [],
      deletedAt: null,
      archivedAt: fixture.archived ? NOW : null,
      settledAt: fixture.settled || fixture.archived ? NOW : null,
    },
    runs: fixture.runStatus === undefined ? [] : [{ status: fixture.runStatus }],
    runtimeRequests: [],
    providerSessions: fixture.background
      ? [
          {
            id: `session-${fixture.id}`,
            status: "ready",
            capabilities: {
              sessions: { supportsMultipleProviderThreadsPerSession: false },
            },
          },
        ]
      : [],
    providerThreads: [],
  }) as unknown as Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "providerSessions" | "providerThreads"
  >;

const usage = (threadId: string, current: boolean): OrchestrationV2DevelopmentEnvironmentUsage => ({
  threadId: ThreadId.make(threadId),
  projectId: PROJECT,
  xwingEnvironmentId: ID,
  repositorySource: "/home/dev/src/app",
  checkoutPath: `${ROOT}/app`,
  number: 7,
  name: "space name",
  firstSelectedAt: "2026-11-01T00:00:00Z",
  lastSelectedAt: "2026-11-02T00:00:00Z",
  threadTitle: `Thread ${threadId}`,
  archivedAt: null,
  settledAt: null,
  current,
});

const schedule = (id: string, threadId: string | null, enabled: boolean) =>
  ({
    id: ScheduledTaskId.make(id),
    title: `Schedule ${id}`,
    enabled,
    threadId: threadId === null ? null : ThreadId.make(threadId),
    workspaceStrategy:
      threadId === null
        ? { type: "existing_worktree", worktreePath: `${ROOT}/app` }
        : { type: "root" },
  }) as unknown as ScheduledTask;

const makeLayer = (input: {
  readonly xwing: ReturnType<typeof makeXwing>;
  readonly threads?: ReadonlyArray<ThreadFixture>;
  readonly usage?: ReadonlyArray<OrchestrationV2DevelopmentEnvironmentUsage>;
  readonly schedules?: ReadonlyArray<ScheduledTask>;
  readonly git?: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly workspaceRoot?: string;
}) => {
  const threads = new Map((input.threads ?? []).map((thread) => [thread.id, thread]));
  const holds = DevelopmentEnvironmentHolds.layer.pipe(
    Layer.provide(
      Layer.mock(ServerEnvironmentIdentity)({
        getEnvironmentId: Effect.succeed(SERVER),
      }),
    ),
  );
  return DevelopmentEnvironmentLifecycle.layer.pipe(
    Layer.provideMerge(holds),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          listDevelopmentEnvironmentUsage: () => Effect.succeed(input.usage ?? []),
          getThreadWorktreePaths: () =>
            Effect.succeed(
              (input.threads ?? []).flatMap((thread) =>
                thread.worktreePath === null
                  ? []
                  : [
                      {
                        threadId: ThreadId.make(thread.id),
                        worktreePath: thread.worktreePath,
                      },
                    ],
              ),
            ),
          getThreadRecords: (threadId) => Effect.succeed(records(threads.get(threadId)!)) as never,
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) }),
        Layer.mock(ProviderSessionManagerV2)({
          get: (sessionId) =>
            Effect.succeed(
              Option.some({
                hasPendingBackgroundWork: Effect.succeed(
                  threads.get(sessionId.replace("session-", ""))?.background === true,
                ),
              }) as never,
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          hasForegroundWork: ({ threadId }) =>
            Effect.succeed(threads.get(threadId)?.terminal === true),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: input.schedules ?? [] }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                workspaceRoot: input.workspaceRoot ?? "/home/dev/src/app/web",
              }) as never,
            ),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute:
            input.git ??
            ((request) =>
              Effect.succeed(
                (request.args[0] === "rev-parse" && request.args[1] === "--show-toplevel"
                  ? { exitCode: 0, stdout: "/home/dev/src/app\n" }
                  : { exitCode: 1, stdout: "" }) as never,
              )),
        }),
        Layer.mock(XwingEnvironments.XwingEnvironments)({
          inspect: () => Effect.fail(new XwingEnvironmentNotFoundError({ environmentId: ID })),
          list: () =>
            Effect.sync(
              () =>
                input.xwing.state.environments.map((environment) => ({
                  id: ID,
                  name: environment.name,
                  status: "active" as const,
                  rootPath: ROOT,
                  createdAt: "now",
                  updatedAt: "now",
                  repositories: environment.sourcePaths.map((sourcePath) => ({
                    name: "app",
                    sourcePath,
                    path: `${ROOT}/app`,
                    branch: "b",
                    exists: true,
                  })),
                })) as never,
            ),
        }),
        input.xwing.operations,
        NodeServices.layer,
      ),
    ),
  );
};

const lifecycle = DevelopmentEnvironmentLifecycle.DevelopmentEnvironmentLifecycle;

const encodeError = Schema.encodeSync(Schema.fromJsonString(DevelopmentEnvironmentLifecycleError));

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const realGit: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (request) =>
  Effect.sync(() => {
    try {
      return { exitCode: 0, stdout: `${runGit(request.cwd, request.args)}\n` } as never;
    } catch {
      return { exitCode: 1, stdout: "" } as never;
    }
  });

/** A clone whose `main` is one commit behind `origin/main`. */
const cloneBehindOrigin = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xwing-launch-"));
  const remote = NodePath.join(root, "remote.git");
  const seed = NodePath.join(root, "seed");
  const clone = NodePath.join(root, "clone");
  const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
  runGit(root, ["init", "--quiet", "--bare", "-b", "main", remote]);
  runGit(root, ["clone", "--quiet", remote, seed]);
  runGit(seed, [...identity, "commit", "--quiet", "--allow-empty", "-m", "one"]);
  runGit(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  runGit(root, ["clone", "--quiet", remote, clone]);
  runGit(seed, [...identity, "commit", "--quiet", "--allow-empty", "-m", "two"]);
  runGit(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  runGit(clone, ["fetch", "--quiet", "origin"]);
  return {
    root,
    clone,
    localHead: runGit(clone, ["rev-parse", "main"]),
    remoteHead: runGit(seed, ["rev-parse", "HEAD"]),
  };
};

const launch = (launchKey: string, overrides: { readonly startFromOrigin?: boolean } = {}) => ({
  projectId: PROJECT,
  launchKey,
  title: "Fix the parser",
  baseRef: "main",
  startFromOrigin: overrides.startFromOrigin ?? false,
});

describe("DevelopmentEnvironmentLifecycle", () => {
  it.effect("forwards app-start diagnostics through the client error", () => {
    const xwing = makeXwing({});
    return Effect.gen(function* () {
      const service = yield* lifecycle;
      const error = yield* Effect.flip(
        service.startApp({ xwingEnvironmentId: ID, repository: "app" }),
      );
      assert.include(error.message, "error: fixture app could not start");
      assert.include(encodeError(error), "error: fixture app could not start");
    }).pipe(Effect.provide(makeLayer({ xwing })));
  });

  it.effect("keeps a created environment when checkout fails and retries into the same id", () => {
    const xwing = makeXwing({});
    xwing.state.attachFailures = 1;
    return Effect.gen(function* () {
      const service = yield* lifecycle;
      const input = {
        projectId: PROJECT,
        name: "space name",
        branch: "feature/space",
      };
      const partial = yield* service.create(input);
      const retried = yield* service.attach({
        ...input,
        xwingEnvironmentId: partial.xwingEnvironmentId,
      });

      assert.deepEqual(partial, {
        xwingEnvironmentId: ID,
        repository: null,
        failure: {
          reason: "baseNotFound",
          message: "The base ref does not exist in the project's repository.",
        },
      });
      assert.notInclude(JSON.stringify(partial), "hunter2");
      assert.equal(retried.repository?.branch, "feature/space");
      assert.deepEqual(xwing.state.calls, [
        "create space name",
        "attach /home/dev/src/app feature/space",
        "attach /home/dev/src/app feature/space",
      ]);
    }).pipe(Effect.provide(makeLayer({ xwing })));
  });

  it.effect("gives each launch its own environment and lets a retry reuse it", () => {
    const xwing = makeXwing({});
    return Effect.gen(function* () {
      const service = yield* lifecycle;
      const first = yield* service.prepareLaunch(launch("thread-a"));
      const second = yield* service.prepareLaunch(launch("thread-b"));
      const retried = yield* service.prepareLaunch(launch("thread-a"));
      assert.isTrue(first.created);
      assert.isTrue(second.created);
      assert.isFalse(retried.created);
      const created = xwing.state.calls.filter((call) => call.startsWith("create "));
      assert.lengthOf(created, 2);
      assert.notEqual(created[0], created[1]);
      for (const call of created) assert.match(call, /^create Fix the parser \[t3 [0-9a-f]{8}\]$/);
      const branches = xwing.state.calls.filter((call) => call.startsWith("attach "));
      assert.lengthOf(branches, 2);
      assert.notEqual(branches[0], branches[1]);
      for (const call of branches) assert.match(call, / t3\/fix-the-parser-[0-9a-f]{8}$/);
    }).pipe(Effect.provide(makeLayer({ xwing })));
  });

  it.effect.each([false, true])(
    "bases a launch on the remote-tracking branch only when startFromOrigin is %s",
    (startFromOrigin) => {
      const repository = cloneBehindOrigin();
      const xwing = makeXwing({});
      return Effect.gen(function* () {
        const service = yield* lifecycle;
        yield* service.prepareLaunch(launch("thread-origin", { startFromOrigin }));
        const base = xwing.state.attachBases[0];
        assert.equal(base, startFromOrigin ? "origin/main" : "main");
        assert.equal(
          runGit(repository.clone, ["rev-parse", `${base}^{commit}`]),
          startFromOrigin ? repository.remoteHead : repository.localHead,
        );
        assert.notEqual(repository.remoteHead, repository.localHead);
      }).pipe(
        Effect.provide(makeLayer({ xwing, git: realGit, workspaceRoot: repository.clone })),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(repository.root, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("removes a launch's new environment when its checkout fails", () => {
    const xwing = makeXwing({});
    xwing.state.attachFailures = 1;
    return Effect.gen(function* () {
      const service = yield* lifecycle;
      const error = yield* Effect.flip(service.prepareLaunch(launch("thread-attach")));
      assert.equal(error.reason, "baseNotFound");
      assert.isTrue(xwing.state.deleted);
      assert.deepEqual(xwing.state.environments, []);
    }).pipe(Effect.provide(makeLayer({ xwing })));
  });

  it.effect(
    "releases the hold and deletes the environment of a launch that was not accepted",
    () => {
      const binding = { threadId: "thread-discard", period: "command-discard" };
      const xwing = makeXwing({ holds: [bindingHold(binding.threadId, binding.period)] });
      return Effect.gen(function* () {
        const service = yield* lifecycle;
        yield* service.discardLaunch({ xwingEnvironmentId: ID, hold: binding });
        assert.deepEqual(xwing.state.holds, []);
        assert.isTrue(xwing.state.deleted);
      }).pipe(Effect.provide(makeLayer({ xwing })));
    },
  );

  it.effect(
    "deletes a failed launch's unchanged new branch so its name works again, and keeps others",
    () => {
      const repository = cloneBehindOrigin();
      const xwing = makeXwing({});
      const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
      const checkoutOf = (branch: string) =>
        NodePath.join(repository.root, "env", branch.replaceAll("/", "-"));
      const branchTip = (branch: string) => {
        try {
          return runGit(repository.clone, [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          ]);
        } catch {
          return null;
        }
      };
      let removeOnDelete: Array<string> = [];
      let commitDuringAttach = false;
      xwing.state.onAttach = (input) => {
        const existing = branchTip(input.branch) !== null;
        runGit(input.sourcePath, [
          "worktree",
          "add",
          "--quiet",
          ...(existing ? [] : ["-b"]),
          ...(existing
            ? [checkoutOf(input.branch), input.branch]
            : [input.branch, checkoutOf(input.branch), input.base ?? "HEAD"]),
        ]);
        removeOnDelete.push(checkoutOf(input.branch));
        // A checkout hook or dependency setup can commit before Xwing returns.
        if (commitDuringAttach) {
          runGit(checkoutOf(input.branch), [
            ...identity,
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "setup",
          ]);
        }
      };
      xwing.state.onDelete = () => {
        for (const checkout of removeOnDelete) {
          runGit(repository.clone, ["worktree", "remove", "--force", checkout]);
        }
        removeOnDelete = [];
      };
      // Delegation and handoff pass the commit they resolved; only that base proves the first commit.
      const launchOn = (launchKey: string, branch: string) => ({
        ...launch(launchKey),
        baseRef: repository.localHead,
        baseIsCommit: true,
        branch,
      });
      const hold = { threadId: "thread-retry", period: "command-retry" };
      return Effect.gen(function* () {
        const service = yield* lifecycle;
        const first = yield* service.prepareLaunch(launchOn("retry-1", "feature/retry"));
        assert.equal(first.newBranch?.name, "feature/retry");
        assert.equal(first.newBranch?.tip, repository.localHead);
        yield* service.discardLaunch({ xwingEnvironmentId: ID, hold, newBranch: first.newBranch });
        assert.isNull(branchTip("feature/retry"));

        // The same name works again, and a branch that gained commits is kept.
        const retried = yield* service.prepareLaunch(launchOn("retry-2", "feature/retry"));
        assert.equal(retried.newBranch?.tip, repository.localHead);
        runGit(checkoutOf("feature/retry"), [
          ...identity,
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "work",
        ]);
        const worked = branchTip("feature/retry");
        assert.notEqual(worked, repository.localHead);
        yield* service.discardLaunch({
          xwingEnvironmentId: ID,
          hold,
          newBranch: retried.newBranch,
        });
        assert.equal(branchTip("feature/retry"), worked);

        // A branch still checked out somewhere is kept.
        const inUse = yield* service.prepareLaunch(launchOn("retry-3", "feature/in-use"));
        removeOnDelete = [];
        yield* service.discardLaunch({ xwingEnvironmentId: ID, hold, newBranch: inUse.newBranch });
        assert.equal(branchTip("feature/in-use"), repository.localHead);

        // A commit made while Xwing attached the branch keeps it.
        commitDuringAttach = true;
        const hooked = yield* service.prepareLaunch(launchOn("retry-5", "feature/hooked"));
        commitDuringAttach = false;
        assert.equal(hooked.newBranch?.tip, repository.localHead);
        const committed = branchTip("feature/hooked");
        assert.notEqual(committed, repository.localHead);
        yield* service.discardLaunch({ xwingEnvironmentId: ID, hold, newBranch: hooked.newBranch });
        assert.equal(branchTip("feature/hooked"), committed);

        // A ref base can resolve differently inside Xwing, so its new branch is never reported,
        // even when the ref looks like a commit.
        const byRef = yield* service.prepareLaunch({ ...launch("retry-6"), branch: "feature/ref" });
        assert.isTrue(byRef.created);
        assert.isUndefined(byRef.newBranch);
        const shaShaped = yield* service.prepareLaunch({
          ...launch("retry-7"),
          baseRef: repository.localHead,
          branch: "feature/sha-shaped",
        });
        assert.isUndefined(shaShaped.newBranch);

        // A branch that existed before the launch is never reported as new.
        runGit(repository.clone, ["branch", "feature/existing", "main"]);
        const existing = yield* service.prepareLaunch(launchOn("retry-4", "feature/existing"));
        assert.isTrue(existing.created);
        assert.isUndefined(existing.newBranch);
      }).pipe(
        Effect.provide(makeLayer({ xwing, git: realGit, workspaceRoot: repository.clone })),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(repository.root, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("names every thread, schedule and hold that keeps the environment", () => {
    const xwing = makeXwing({
      dirty: true,
      holds: [bindingHold("idle", "select-1"), hold("sparkwing", "job-9", "CI job")],
    });
    const threads: ReadonlyArray<ThreadFixture> = [
      { id: "unsettled", worktreePath: `${ROOT}/app` },
      {
        id: "turn",
        worktreePath: `${ROOT}/app`,
        settled: true,
        runStatus: "running",
      },
      {
        id: "queued",
        worktreePath: `${ROOT}/app`,
        settled: true,
        runStatus: "queued",
      },
      {
        id: "subagent",
        worktreePath: `${ROOT}/app`,
        settled: true,
        background: true,
      },
      {
        id: "shell",
        worktreePath: `${ROOT}/app/web`,
        settled: true,
        terminal: true,
      },
      { id: "idle", worktreePath: `${ROOT}/app`, settled: true },
      { id: "archived", worktreePath: `${ROOT}/app`, archived: true },
      { id: "moved", worktreePath: "/elsewhere", runStatus: "running" },
      {
        id: "scratch",
        worktreePath: "/home/user/code",
        settled: true,
        runStatus: "running",
        linked: true,
      },
      {
        id: "released",
        worktreePath: "/elsewhere",
        linked: true,
        released: true,
        runStatus: "running",
      },
    ];
    return Effect.gen(function* () {
      const assessment = yield* (yield* lifecycle).assessCleanup({
        xwingEnvironmentId: ID,
      });

      assert.isFalse(assessment.canClean);
      assert.deepEqual(
        assessment.threads.map((thread) => [thread.threadId, thread.current, thread.block]),
        [
          ["moved", false, null],
          ["scratch", true, "working"],
          ["released", false, null],
          ["unsettled", true, "unsettled"],
          ["turn", true, "working"],
          ["queued", true, "working"],
          ["subagent", true, "background-work"],
          ["shell", true, "terminal-command"],
          ["idle", true, null],
          ["archived", true, null],
        ],
      );
      assert.deepEqual(
        assessment.schedules.map((task) => task.scheduledTaskId),
        ["on-idle-thread", "in-checkout"],
      );
      assert.deepEqual(
        assessment.ownHolds.map((own) => own.threadId),
        [ThreadId.make("idle")],
      );
      assert.deepEqual(
        assessment.foreignHolds.map((foreign) => foreign.owner),
        ["sparkwing"],
      );
      assert.deepEqual(assessment.xwingBlockers, [
        "app has uncommitted or untracked work; use --discard-work",
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          xwing,
          threads,
          usage: [usage("moved", false), usage("scratch", true), usage("released", false)],
          schedules: [
            schedule("on-idle-thread", "idle", true),
            schedule("in-checkout", null, true),
            schedule("disabled", "idle", false),
            schedule("on-moved-thread", "moved", true),
          ],
        }),
      ),
    );
  });

  it.effect.each(["delete", "archive"] as const)(
    "%s after the last thread settled, releasing only this server's holds",
    (action) => {
      const xwing = makeXwing({
        holds: [bindingHold("idle", "select-1"), bindingHold("gone", "launch-1")],
      });
      return Effect.gen(function* () {
        const service = yield* lifecycle;
        const assessment = yield* service.assessCleanup({
          xwingEnvironmentId: ID,
        });
        const result = yield* service.cleanUp({
          xwingEnvironmentId: ID,
          fingerprint: assessment.fingerprint,
          action,
        });

        assert.isTrue(assessment.canClean);
        assert.deepEqual(
          assessment.threads.map((thread) => thread.threadId),
          ["moved", "idle"],
        );
        assert.deepEqual(result, {
          xwingEnvironmentId: ID,
          outcome: action === "delete" ? "deleted" : "archived",
          releasedHolds: assessment.ownHolds.map((own) => own.key),
          stoppedApplications: action === "delete" ? ["web"] : [],
          retainedPaths:
            action === "delete" ? [`/home/dev/.xwing/runs/${ID}`] : ["/home/dev/.xwing/archives/7"],
        });
        assert.equal(xwing.state.deleted, action === "delete");
        assert.equal(xwing.state.archived, action === "archive");
      }).pipe(
        Effect.provide(
          makeLayer({
            xwing,
            threads: [
              { id: "idle", worktreePath: `${ROOT}/app`, settled: true },
              { id: "moved", worktreePath: "/elsewhere", runStatus: "running" },
            ],
            usage: [usage("moved", false)],
          }),
        ),
      );
    },
  );

  it.effect("refuses a confirmation once a newer binding holds the environment", () => {
    const xwing = makeXwing({ holds: [bindingHold("idle", "select-1")] });
    return Effect.gen(function* () {
      const service = yield* lifecycle;
      const holds = yield* DevelopmentEnvironmentHolds.DevelopmentEnvironmentHolds;
      const reviewed = yield* service.assessCleanup({
        xwingEnvironmentId: ID,
      });
      const committing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const binding = yield* holds
        .retain(
          {
            xwingEnvironmentId: ID,
            threadId: "idle",
            period: "select-2",
            title: "idle",
          },
          Deferred.succeed(committing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(committing);
      const cleanup = yield* service
        .cleanUp({
          xwingEnvironmentId: ID,
          fingerprint: reviewed.fingerprint,
          action: "delete",
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(binding);
      const refused = yield* Fiber.join(cleanup);

      assert.equal(refused.reason, "assessment-changed");
      assert.isFalse(xwing.state.deleted);
      assert.deepEqual(
        xwing.state.holds.map((held) => held.key),
        [
          DevelopmentEnvironmentHolds.holdKey({
            threadId: "idle",
            period: "select-1",
          }),
          DevelopmentEnvironmentHolds.holdKey({
            threadId: "idle",
            period: "select-2",
          }),
        ],
      );
      assert.notInclude(xwing.state.calls.join("\n"), "release");
    }).pipe(
      Effect.provide(
        makeLayer({
          xwing,
          threads: [{ id: "idle", worktreePath: `${ROOT}/app`, settled: true }],
        }),
      ),
    );
  });

  it.effect.each([
    { case: "another T3 server's hold", dirty: false, foreign: true, scheduled: false },
    { case: "unsaved work", dirty: true, foreign: false, scheduled: false },
    { case: "a schedule for an idle thread", dirty: false, foreign: false, scheduled: true },
  ])("never releases a hold or deletes while $case remains", ({ dirty, foreign, scheduled }) => {
    const xwing = makeXwing({
      dirty,
      holds: [
        bindingHold("idle", "select-1"),
        ...(foreign ? [hold("t3-server-other", "thread-x", "Other T3")] : []),
      ],
    });
    return Effect.gen(function* () {
      const service = yield* lifecycle;
      const assessment = yield* service.assessCleanup({
        xwingEnvironmentId: ID,
      });
      const refused = yield* service
        .cleanUp({
          xwingEnvironmentId: ID,
          fingerprint: assessment.fingerprint,
          action: "delete",
        })
        .pipe(Effect.flip);

      assert.equal(refused.reason, "cleanup-blocked");
      assert.deepEqual(xwing.state.calls, []);
      assert.lengthOf(xwing.state.holds, foreign ? 2 : 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          xwing,
          threads: [{ id: "idle", worktreePath: `${ROOT}/app`, settled: true }],
          schedules: scheduled ? [schedule("nightly", "idle", true)] : [],
        }),
      ),
    );
  });

  it.effect("restores released holds when Xwing refuses the deletion and hides its output", () => {
    const xwing = makeXwing({ holds: [bindingHold("idle", "select-1")] });
    const key = DevelopmentEnvironmentHolds.holdKey({ threadId: "idle", period: "select-1" });
    return Effect.gen(function* () {
      const service = yield* lifecycle;
      const assessment = yield* service.assessCleanup({ xwingEnvironmentId: ID });
      xwing.state.refuseDelete = true;
      const refused = yield* service
        .cleanUp({ xwingEnvironmentId: ID, fingerprint: assessment.fingerprint, action: "delete" })
        .pipe(Effect.flip);

      const retried = yield* service
        .cleanUp({ xwingEnvironmentId: ID, fingerprint: assessment.fingerprint, action: "delete" })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "blocked");
      assert.equal(retried.reason, "blocked");
      assert.notInclude(encodeError(refused), "hunter2");
      assert.notInclude(encodeError(retried), "hunter2");
      assert.notInclude(refused.message, "hunter2");
      assert.deepEqual(xwing.state.calls, [
        `release ${OWNER} ${key}`,
        "delete",
        `register ${OWNER} ${key}`,
        `release ${OWNER} ${key}`,
        "delete",
        `register ${OWNER} ${key}`,
      ]);
      assert.deepEqual(
        xwing.state.holds.map((held) => [held.key, held.label]),
        [[key, "T3 Code: idle"]],
      );
    }).pipe(
      Effect.provide(
        makeLayer({ xwing, threads: [{ id: "idle", worktreePath: `${ROOT}/app`, settled: true }] }),
      ),
    );
  });
});
