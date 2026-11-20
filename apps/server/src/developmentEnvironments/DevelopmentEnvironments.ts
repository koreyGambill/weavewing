import {
  type CommandId,
  isProviderNativeSubagentThread,
  type ThreadChangeFolderInput,
  type DevelopmentEnvironmentUnlinkInput,
  type ThreadChangeFolderError,
  ThreadFolderUnavailableError,
  type DevelopmentEnvironmentCheckoutChoice,
  DevelopmentEnvironmentPersistenceError,
  DevelopmentEnvironmentProjectNotFoundError,
  DevelopmentEnvironmentSelectionRejectedError,
  type ProjectId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2AppThread,
  type ThreadId,
  type OrchestrationV2DevelopmentEnvironmentCheckout,
  type OrchestrationV2DevelopmentEnvironmentUsage,
  type OrchestrationV2ThreadDevelopmentEnvironment,
  type XwingListError,
  type OrchestrationV2WorktreeThreadIds,
} from "@t3tools/contracts";

import { normalizeProjectPathForComparison, workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { WorktreeRemovalOwnership } from "../vcs/worktreeRemoval.ts";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DevelopmentEnvironmentCheckouts from "./DevelopmentEnvironmentCheckouts.ts";
import * as DevelopmentEnvironmentHolds from "./DevelopmentEnvironmentHolds.ts";

export {
  DevelopmentEnvironmentPersistenceError,
  DevelopmentEnvironmentProjectNotFoundError,
  DevelopmentEnvironmentSelectionRejectedError,
};

/** Where a stopped thread should work next. `native` leaves Xwing and keeps T3's own checkout rules. */
export type DevelopmentEnvironmentSelectionTarget =
  | { readonly type: "xwing"; readonly xwingEnvironmentId: string; readonly workspaceRoot?: string }
  | {
      readonly type: "native";
      readonly worktreePath: string | null;
      readonly branch: string | null;
    };

export interface DevelopmentEnvironmentSelectionInput {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  /** The checkout the caller saw; selection is rejected if the thread has moved since. */
  readonly expected: {
    readonly projectId?: ProjectId | undefined;
    readonly worktreePath: string | null;
    readonly xwingEnvironmentId: string | null;
  };
  readonly target: DevelopmentEnvironmentSelectionTarget;
}

/**
 * The thread's checkout once the selection committed. When `changed` is true, terminals and
 * provider sessions from the previous checkout were closed, and clients should drop any launch
 * context (cwd, terminal sessions) kept for it.
 */
export interface DevelopmentEnvironmentSelectionResult {
  readonly changed: boolean;
  readonly sequence: number;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly developmentEnvironment: OrchestrationV2ThreadDevelopmentEnvironment | null;
}

export interface DevelopmentEnvironmentLaunchWorkspace {
  readonly workspaceStrategy: {
    readonly type: "existing_worktree";
    readonly worktreePath: string;
    readonly branch?: string;
  };
  readonly developmentEnvironment: OrchestrationV2DevelopmentEnvironmentCheckout;
}

/**
 * Binds threads to Xwing checkouts; Xwing owns each environment's lifecycle. Launches spread
 * `resolveLaunchWorkspace` into `ThreadLaunchService.launch` inside `bindLaunch`; stopped threads
 * move with `selectCheckout`; `listUsage` reads which threads used which environment.
 */
export class DevelopmentEnvironments extends Context.Service<
  DevelopmentEnvironments,
  {
    readonly getWorktreeThreadIds: (input: {
      readonly worktreePath: string;
    }) => Effect.Effect<OrchestrationV2WorktreeThreadIds, Orchestrator.OrchestratorV2Error>;
    readonly unlink: (
      input: DevelopmentEnvironmentUnlinkInput,
    ) => Effect.Effect<void, DevelopmentEnvironmentPersistenceError>;
    readonly changeFolder: (
      input: ThreadChangeFolderInput,
    ) => Effect.Effect<DevelopmentEnvironmentSelectionResult, ThreadChangeFolderError>;
    readonly selectCheckout: (
      input: DevelopmentEnvironmentSelectionInput,
    ) => Effect.Effect<
      DevelopmentEnvironmentSelectionResult,
      | DevelopmentEnvironmentSelectionRejectedError
      | DevelopmentEnvironmentCheckouts.DevelopmentEnvironmentCheckoutUnavailableError
      | DevelopmentEnvironmentPersistenceError
    >;
    /**
     * Runs a launch into an Xwing checkout while holding the environment for it. The hold stays
     * if the launch fails, since a failed launch may still have created the thread; cleanup
     * releases it.
     */
    readonly bindLaunch: <A, E, R>(
      binding: {
        readonly xwingEnvironmentId: string;
        readonly threadId: ThreadId | undefined;
        readonly commandId: CommandId;
        readonly title: string;
      },
      launch: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | DevelopmentEnvironmentCheckouts.DevelopmentEnvironmentCheckoutUnavailableError,
      R
    >;
    /** The `workspaceStrategy` and `developmentEnvironment` to pass to a thread launch. */
    readonly resolveLaunchWorkspace: (input: {
      readonly projectId: ProjectId;
      readonly xwingEnvironmentId: string;
    }) => Effect.Effect<
      DevelopmentEnvironmentLaunchWorkspace,
      | DevelopmentEnvironmentProjectNotFoundError
      | DevelopmentEnvironmentCheckouts.DevelopmentEnvironmentCheckoutUnavailableError
    >;
    /** Checkouts of the project's repository a thread here could launch in or move to. */
    readonly listCheckouts: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      ReadonlyArray<DevelopmentEnvironmentCheckoutChoice>,
      DevelopmentEnvironmentProjectNotFoundError | XwingListError
    >;
    /** Recorded selections, newest first, including archived and settled threads. */
    readonly listUsage: (filter: {
      readonly xwingEnvironmentId?: string | undefined;
      readonly threadId?: ThreadId | undefined;
      readonly includeDescendants?: boolean | undefined;
    }) => Effect.Effect<
      ReadonlyArray<OrchestrationV2DevelopmentEnvironmentUsage>,
      DevelopmentEnvironmentPersistenceError
    >;
  }
>()("t3/developmentEnvironments/DevelopmentEnvironments") {}

const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkouts = yield* DevelopmentEnvironmentCheckouts.DevelopmentEnvironmentCheckouts;
  const terminals = yield* TerminalManager.TerminalManager;
  const holds = yield* DevelopmentEnvironmentHolds.DevelopmentEnvironmentHolds;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const { canonical, repositoryOf } = yield* DevelopmentEnvironmentCheckouts.makeGitCheckoutLookup;
  const path = yield* Path.Path;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const ownership = yield* WorktreeRemovalOwnership;

  const getWorktreeThreadIds: DevelopmentEnvironments["Service"]["getWorktreeThreadIds"] =
    Effect.fn("DevelopmentEnvironments.getWorktreeThreadIds")(function* ({ worktreePath }) {
      const snapshot = yield* Effect.flatten(
        threads.readShellSnapshot({ location: "active", worktreePath }),
      );
      return {
        threadIds: snapshot.threads.map((thread) => thread.id),
        isManagedWorktree:
          (yield* isManagedWorktreePath(worktreePath)) &&
          (yield* ownership.ownerOf(worktreePath)) === null,
      };
    });

  const bindLaunch: DevelopmentEnvironments["Service"]["bindLaunch"] = (binding, launch) =>
    holds.retain(
      {
        xwingEnvironmentId: binding.xwingEnvironmentId,
        // A launch without a thread id gets one at creation; its hold names the command instead.
        threadId: binding.threadId ?? binding.commandId,
        period: binding.commandId,
        title: binding.title,
      },
      launch,
      { keepOnFailure: true },
    );

  const projectRoot = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(() => new DevelopmentEnvironmentProjectNotFoundError({ projectId })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new DevelopmentEnvironmentProjectNotFoundError({ projectId })),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  const resolveLaunchWorkspace: DevelopmentEnvironments["Service"]["resolveLaunchWorkspace"] =
    Effect.fn("DevelopmentEnvironments.resolveLaunchWorkspace")(function* (input) {
      const { branch, ...developmentEnvironment } = yield* checkouts.resolve({
        xwingEnvironmentId: input.xwingEnvironmentId,
        workspaceRoot: yield* projectRoot(input.projectId),
      });
      return {
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: developmentEnvironment.checkoutPath,
          ...(branch === null ? {} : { branch }),
        },
        developmentEnvironment,
      };
    });

  const folderKey = (target: string) =>
    canonical(target).pipe(Effect.map(normalizeProjectPathForComparison));

  const projectForFolder = Effect.fn("DevelopmentEnvironments.projectForFolder")(
    function* (folder: string) {
      const destination = yield* folderKey(folder);
      const registered = yield* projects.listShells();
      const roots = (yield* Effect.forEach(
        registered.filter((project) => project.archivedAt == null),
        (project) =>
          Effect.gen(function* () {
            if (yield* managedFolders.isScratchProject(project.id)) return null;
            return { id: project.id, root: yield* folderKey(project.workspaceRoot) };
          }),
        { concurrency: 8 },
      )).filter((project) => project !== null);
      let matching = roots.filter(
        ({ root }) => workspaceRelativeFilePath(destination, root) !== null,
      );
      const exact = matching.filter(({ root }) => root === destination);
      if (exact.length === 1) return exact[0]!.id;
      if (exact.length === 0 && roots.length > 0) {
        const repository = yield* repositoryOf(destination);
        if (repository !== null) {
          const translated = (yield* Effect.forEach(
            roots.filter((project) => !matching.includes(project)),
            ({ id, root }) =>
              Effect.gen(function* () {
                const candidate = yield* repositoryOf(root);
                if (
                  candidate === null ||
                  normalizeProjectPathForComparison(candidate.commonDir) !==
                    normalizeProjectPathForComparison(repository.commonDir)
                )
                  return null;
                const relativeRoot = workspaceRelativeFilePath(root, candidate.topLevel);
                if (relativeRoot === null) return null;
                const checkoutRoot = yield* folderKey(
                  path.resolve(repository.topLevel, relativeRoot),
                );
                return workspaceRelativeFilePath(destination, checkoutRoot) === null
                  ? null
                  : { id, root: checkoutRoot };
              }),
            { concurrency: 8 },
          )).filter((project) => project !== null);
          matching = [...matching, ...translated];
        }
      }
      matching.sort((a, b) => b.root.length - a.root.length);
      const [deepest, next] = matching;
      if (deepest && deepest.root.length !== next?.root.length) return deepest.id;
      return (yield* managedFolders.ensureScratchProject).projectId;
    },
    Effect.mapError(
      () => new DevelopmentEnvironmentPersistenceError({ operation: "select-workspace" }),
    ),
  );

  const dispatchSelection = (
    command: Extract<OrchestrationV2ServerCommand, { type: "thread.workspace.select" }>,
  ) =>
    threads.dispatch(command).pipe(
      Effect.catchTags({
        OrchestratorWorkspaceSelectionRejectedError: (cause) =>
          Effect.fail(
            new DevelopmentEnvironmentSelectionRejectedError({
              threadId: command.threadId,
              reason: cause.reason,
            }),
          ),
      }),
      Effect.mapError((cause) =>
        cause._tag === "DevelopmentEnvironmentSelectionRejectedError"
          ? cause
          : new DevelopmentEnvironmentPersistenceError({ operation: "select-workspace" }),
      ),
    );

  const selectionResult = (
    dispatched: Orchestrator.OrchestratorV2DispatchResult,
    thread: Pick<OrchestrationV2AppThread, "worktreePath" | "branch" | "developmentEnvironment">,
  ): DevelopmentEnvironmentSelectionResult => {
    const selected = dispatched.storedEvents.findLast(
      (stored) => stored.event.type === "thread.metadata-updated",
    );
    const after =
      selected?.event.type === "thread.metadata-updated" ? selected.event.payload : thread;
    return {
      changed: selected !== undefined,
      sequence: dispatched.sequence,
      worktreePath: after.worktreePath,
      branch: after.branch,
      developmentEnvironment: after.developmentEnvironment ?? null,
    };
  };

  const selectWorkspace = Effect.fn("DevelopmentEnvironments.selectCheckout")(function* (
    input: DevelopmentEnvironmentSelectionInput,
    associateProject = false,
  ) {
    const reject = (reason: DevelopmentEnvironmentSelectionRejectedError["reason"]) =>
      new DevelopmentEnvironmentSelectionRejectedError({
        threadId: input.threadId,
        reason,
      });
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs", "runtimeRequests"])
      .pipe(
        Effect.mapError((cause) =>
          "cause" in cause && isThreadNotFound(cause.cause)
            ? reject("thread-not-found")
            : new DevelopmentEnvironmentPersistenceError({ operation: "read-thread" }),
        ),
      );
    const { thread } = records;
    if (associateProject && (yield* threads.hasReceipt(input.commandId))) {
      const dispatched = yield* dispatchSelection({
        type: "thread.workspace.select",
        commandId: input.commandId,
        threadId: input.threadId,
        expected: input.expected,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        developmentEnvironment: thread.developmentEnvironment ?? null,
      });
      return selectionResult(dispatched, thread);
    }
    if (thread.deletedAt !== null) return yield* reject("deleted");
    if (isProviderNativeSubagentThread(thread)) return yield* reject("provider-native-subagent");
    // Checked again under the orchestrator's lock; checking first keeps a rejected move from
    // leaving a hold behind.
    if (
      (input.expected.projectId !== undefined && input.expected.projectId !== thread.projectId) ||
      input.expected.worktreePath !== thread.worktreePath ||
      input.expected.xwingEnvironmentId !==
        (thread.developmentEnvironment?.xwingEnvironmentId ?? null)
    ) {
      return yield* reject("workspace-changed");
    }
    if (Orchestrator.threadHasUnfinishedWork(records)) return yield* reject("work-in-progress");
    const requested = input.target;
    const target =
      requested.type === "native"
        ? { ...requested, developmentEnvironment: null }
        : yield* Effect.gen(function* () {
            const workspaceRoot =
              requested.workspaceRoot ??
              (yield* projectRoot(thread.projectId).pipe(
                Effect.mapError(() => reject("project-missing")),
              ));
            const { branch, ...developmentEnvironment } = yield* checkouts.resolve({
              xwingEnvironmentId: requested.xwingEnvironmentId,
              workspaceRoot,
            });
            return {
              worktreePath: developmentEnvironment.checkoutPath,
              branch,
              developmentEnvironment,
            };
          });
    // Moving closes the old checkout's idle shells; a running command must finish first.
    if (
      target.worktreePath !== thread.worktreePath &&
      input.expected.worktreePath === thread.worktreePath &&
      (yield* terminals.hasForegroundWork({
        threadId: input.threadId,
        worktreePath: thread.worktreePath,
      }))
    ) {
      return yield* reject("work-in-progress");
    }
    const current = thread.developmentEnvironment ?? null;
    const projectId =
      associateProject && target.worktreePath !== null
        ? yield* projectForFolder(target.worktreePath)
        : undefined;
    const dispatch = dispatchSelection({
      type: "thread.workspace.select",
      commandId: input.commandId,
      threadId: input.threadId,
      expected: { ...input.expected, projectId: input.expected.projectId ?? thread.projectId },
      worktreePath: target.worktreePath,
      branch: target.branch,
      developmentEnvironment: target.developmentEnvironment,
      ...(projectId === undefined ? {} : { projectId }),
    });
    // A new binding commits holding its own period's key; a failed dispatch releases it.
    const dispatched = yield* target.developmentEnvironment !== null &&
    (current?.xwingEnvironmentId !== target.developmentEnvironment.xwingEnvironmentId ||
      current.checkoutPath !== target.developmentEnvironment.checkoutPath)
      ? holds.retain(
          {
            xwingEnvironmentId: target.developmentEnvironment.xwingEnvironmentId,
            threadId: input.threadId,
            period: input.commandId,
            title: thread.title,
          },
          dispatch,
        )
      : dispatch;
    return selectionResult(dispatched, thread);
  });

  const selectCheckout: DevelopmentEnvironments["Service"]["selectCheckout"] = (input) =>
    selectWorkspace(input);

  const changeFolder: DevelopmentEnvironments["Service"]["changeFolder"] = Effect.fn(
    "DevelopmentEnvironments.changeFolder",
  )(function* (input) {
    if (yield* threads.hasReceipt(input.commandId)) {
      // Replaying a committed move must work even if its folder is gone now.
      return yield* selectWorkspace(
        {
          ...input,
          target: { type: "native", worktreePath: null, branch: null },
        },
        true,
      );
    }
    const folder = yield* paths
      .normalizeWorkspaceRoot(input.folder)
      .pipe(
        Effect.mapError(
          (cause) => new ThreadFolderUnavailableError({ folder: input.folder, cause }),
        ),
      );
    let xwingEnvironmentId = input.xwingEnvironmentId;
    if (xwingEnvironmentId === undefined) {
      const choices = yield* checkouts.list({ workspaceRoot: folder }).pipe(
        Effect.catchTags({ XwingUnavailableError: () => Effect.succeed([]) }),
        Effect.mapError((cause) => new ThreadFolderUnavailableError({ folder, cause })),
      );
      const key = yield* folderKey(folder);
      for (const choice of choices) {
        if ((yield* folderKey(choice.checkoutPath)) === key) {
          xwingEnvironmentId = choice.xwingEnvironmentId;
          break;
        }
      }
    }
    const branch = yield* git
      .execute({
        operation: "change-folder",
        cwd: folder,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
        Effect.orElseSucceed(() => null),
      );
    return yield* selectWorkspace(
      {
        threadId: input.threadId,
        commandId: input.commandId,
        expected: input.expected,
        target:
          xwingEnvironmentId === undefined
            ? { type: "native", worktreePath: folder, branch }
            : { type: "xwing", xwingEnvironmentId, workspaceRoot: folder },
      },
      true,
    );
  });

  const listCheckouts: DevelopmentEnvironments["Service"]["listCheckouts"] = Effect.fn(
    "DevelopmentEnvironments.listCheckouts",
  )(function* (input) {
    return yield* checkouts.list({ workspaceRoot: yield* projectRoot(input.projectId) });
  });

  const unlink: DevelopmentEnvironments["Service"]["unlink"] = Effect.fn(
    "DevelopmentEnvironments.unlink",
  )(function* (input) {
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        unlinkDevelopmentEnvironmentId: input.xwingEnvironmentId,
      })
      .pipe(
        Effect.mapError(() => new DevelopmentEnvironmentPersistenceError({ operation: "unlink" })),
      );
  });

  const listUsage: DevelopmentEnvironments["Service"]["listUsage"] = (filter) =>
    projections.listDevelopmentEnvironmentUsage(filter).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Development environment usage read failed", cause),
      ),
      Effect.mapError(
        () => new DevelopmentEnvironmentPersistenceError({ operation: "list-usage" }),
      ),
      Effect.withSpan("DevelopmentEnvironments.listUsage"),
    );

  return DevelopmentEnvironments.of({
    bindLaunch,
    unlink,
    getWorktreeThreadIds,
    changeFolder,
    selectCheckout,
    resolveLaunchWorkspace,
    listCheckouts,
    listUsage,
  });
});

export const layer = Layer.effect(DevelopmentEnvironments, make);
