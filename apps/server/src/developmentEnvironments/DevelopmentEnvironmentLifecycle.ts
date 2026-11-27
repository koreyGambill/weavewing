import {
  type DevelopmentEnvironmentAppCommand,
  type DevelopmentEnvironmentAppCommandsInput,
  type DevelopmentEnvironmentAppLogsInput,
  type DevelopmentEnvironmentAttachInput,
  type DevelopmentEnvironmentCleanupAssessment,
  type DevelopmentEnvironmentCleanupHold,
  type DevelopmentEnvironmentCleanupThread,
  type DevelopmentEnvironmentCleanUpInput,
  type DevelopmentEnvironmentCleanUpResult,
  type DevelopmentEnvironmentCreateInput,
  DevelopmentEnvironmentLifecycleError,
  type DevelopmentEnvironmentLifecycleOperation,
  type DevelopmentEnvironmentRef,
  type DevelopmentEnvironmentSetupResult,
  type DevelopmentEnvironmentStartAppInput,
  type DevelopmentEnvironmentStopAppInput,
  type DevelopmentEnvironmentThreadBlock,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ThreadId,
  type XwingAppLogs,
  type XwingApplicationRun,
  type XwingEnvironmentId,
  type XwingOperationError,
  type XwingRepairResult,
  type XwingRestoreResult,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the assessment fingerprint is a plain digest.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { providerSessionHasBackgroundWork } from "../orchestration-v2/providerBackgroundWork.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as XwingEnvironments from "../xwing/XwingEnvironments.ts";
import * as XwingOperations from "../xwing/XwingOperations.ts";
import * as DevelopmentEnvironmentHolds from "./DevelopmentEnvironmentHolds.ts";
import { holdKey } from "./DevelopmentEnvironmentHolds.ts";
import { sanitizeBranchFragment, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";

export { DevelopmentEnvironmentLifecycleError };

type Failure<A> = Effect.Effect<A, DevelopmentEnvironmentLifecycleError>;

/** A branch `prepareLaunch` created in the project's repository, and the commit it started at. */
export interface LaunchBranch {
  readonly sourcePath: string;
  readonly name: string;
  readonly tip: string;
}

/**
 * Creates, sets up, runs apps in and cleans up Xwing environments for T3 Code. Every error it
 * returns is safe to send to a client: Xwing's output stays in the server log. Cleanup is only
 * ever an assessment followed by a confirmation of that exact assessment; nothing here deletes an
 * environment or releases a hold because a thread settled.
 */
export class DevelopmentEnvironmentLifecycle extends Context.Service<
  DevelopmentEnvironmentLifecycle,
  {
    readonly create: (
      input: DevelopmentEnvironmentCreateInput,
    ) => Failure<DevelopmentEnvironmentSetupResult>;
    readonly attach: (
      input: DevelopmentEnvironmentAttachInput,
    ) => Failure<DevelopmentEnvironmentSetupResult>;
    readonly restore: (input: DevelopmentEnvironmentRef) => Failure<XwingRestoreResult>;
    readonly repair: (input: DevelopmentEnvironmentRef) => Failure<XwingRepairResult>;
    readonly listAppCommands: (
      input: DevelopmentEnvironmentAppCommandsInput,
    ) => Failure<ReadonlyArray<DevelopmentEnvironmentAppCommand>>;
    readonly startApp: (
      input: DevelopmentEnvironmentStartAppInput,
    ) => Failure<ReadonlyArray<XwingApplicationRun>>;
    readonly stopApp: (input: DevelopmentEnvironmentStopAppInput) => Failure<XwingApplicationRun>;
    readonly readAppLogs: (input: DevelopmentEnvironmentAppLogsInput) => Failure<XwingAppLogs>;
    readonly assessCleanup: (
      input: DevelopmentEnvironmentRef,
    ) => Failure<DevelopmentEnvironmentCleanupAssessment>;
    /** Archives or deletes only if a fresh assessment still matches `fingerprint` and allows it. */
    readonly cleanUp: (
      input: DevelopmentEnvironmentCleanUpInput,
    ) => Failure<DevelopmentEnvironmentCleanUpResult>;
    /**
     * The environment for one isolated thread launch, named from its stable launch key: a retry
     * finds the environment an earlier attempt made, and separate launches each get their own.
     * `startFromOrigin` bases a new branch on the base branch's remote-tracking ref.
     * `newBranch` names the branch this call created, for `discardLaunch`.
     */
    readonly prepareLaunch: (input: {
      readonly projectId: ProjectId;
      readonly launchKey: string;
      readonly title: string;
      readonly branch?: string | undefined;
      readonly baseRef: string;
      readonly startFromOrigin: boolean;
    }) => Failure<{
      readonly xwingEnvironmentId: XwingEnvironmentId;
      readonly created: boolean;
      readonly newBranch?: LaunchBranch | undefined;
    }>;
    /**
     * Releases a launch's hold and deletes the environment `prepareLaunch` made for it. Xwing
     * keeps branches, so `newBranch` is deleted too while it is still at its first commit and no
     * checkout uses it; anything else keeps it.
     */
    readonly discardLaunch: (input: {
      readonly xwingEnvironmentId: XwingEnvironmentId;
      readonly hold: { readonly threadId: string; readonly period: string };
      readonly newBranch?: LaunchBranch | undefined;
    }) => Effect.Effect<void>;
  }
>()("t3/developmentEnvironments/DevelopmentEnvironmentLifecycle") {}

const lifecycleError = (
  operation: DevelopmentEnvironmentLifecycleOperation,
  reason: DevelopmentEnvironmentLifecycleError["reason"],
  xwingEnvironmentId?: string,
  blockers?: ReadonlyArray<string>,
  diagnostics?: string,
) =>
  new DevelopmentEnvironmentLifecycleError({
    operation,
    reason,
    ...(xwingEnvironmentId === undefined ? {} : { xwingEnvironmentId }),
    ...(blockers === undefined ? {} : { blockers }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });

const reasonOf = (error: XwingOperationError): DevelopmentEnvironmentLifecycleError["reason"] => {
  switch (error._tag) {
    case "XwingUnavailableError":
      return "xwing-unavailable";
    case "XwingOperationUnsupportedError":
      return "xwing-unsupported";
    case "XwingInvalidInputError":
      return "invalid-input";
    case "XwingOperationFailedError":
      return error.category;
  }
};

/** Logs the cause and forwards app-start diagnostics to the client. */
const sanitized =
  (operation: DevelopmentEnvironmentLifecycleOperation, xwingEnvironmentId?: string) =>
  (error: XwingOperationError) =>
    Effect.logWarning("Xwing development environment operation failed", error).pipe(
      Effect.annotateLogs({
        operation,
        xwingEnvironmentId: xwingEnvironmentId ?? "",
      }),
      Effect.as(
        lifecycleError(
          operation,
          reasonOf(error),
          error._tag === "XwingOperationFailedError"
            ? (error.environmentId ?? xwingEnvironmentId)
            : xwingEnvironmentId,
          error._tag === "XwingOperationFailedError" ? error.blockers : undefined,
          error._tag === "XwingOperationFailedError" ? error.diagnostics : undefined,
        ),
      ),
    );

const RUNNING_APP_STATUSES = new Set(["running", "starting", "stopping"]);

const make = Effect.gen(function* () {
  const operations = yield* XwingOperations.XwingOperations;
  const catalog = yield* XwingEnvironments.XwingEnvironments;
  const holds = yield* DevelopmentEnvironmentHolds.DevelopmentEnvironmentHolds;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const providerSessions = yield* ProviderSessionManagerV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const schedules = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;

  const unreadable =
    (operation: DevelopmentEnvironmentLifecycleOperation, id: string) => (cause: unknown) =>
      Effect.logWarning("Development environment state could not be read", cause).pipe(
        Effect.as(lifecycleError(operation, "state-unreadable", id)),
      );

  // Xwing records the repository by its top level, whichever project folder asks.
  const projectSource = Effect.fn("DevelopmentEnvironmentLifecycle.projectSource")(function* (
    operation: DevelopmentEnvironmentLifecycleOperation,
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) return yield* lifecycleError(operation, "project-missing");
    const result = yield* git
      .execute({
        operation: "DevelopmentEnvironmentLifecycle.projectSource",
        cwd: project.value.workspaceRoot,
        args: ["rev-parse", "--show-toplevel"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(Effect.orElseSucceed(() => null));
    const topLevel = result?.exitCode === 0 ? result.stdout.trim() : "";
    if (topLevel === "") return yield* lifecycleError(operation, "not-a-repository");
    return topLevel;
  });

  const attachProject = Effect.fn("DevelopmentEnvironmentLifecycle.attachProject")(function* (
    id: XwingEnvironmentId,
    sourcePath: string,
    input: { readonly branch: string; readonly base?: string | undefined },
  ) {
    const attempt = yield* Effect.result(
      operations.attachRepository({
        id,
        sourcePath,
        branch: input.branch,
        ...(input.base === undefined ? {} : { base: input.base }),
      }),
    );
    if (Result.isSuccess(attempt)) {
      return { xwingEnvironmentId: id, repository: attempt.success, failure: null };
    }
    const safe = yield* sanitized("attach", id)(attempt.failure);
    return {
      xwingEnvironmentId: id,
      repository: null,
      failure: { reason: safe.reason, message: safe.message },
    } satisfies DevelopmentEnvironmentSetupResult;
  });

  const create: DevelopmentEnvironmentLifecycle["Service"]["create"] = Effect.fn(
    "DevelopmentEnvironmentLifecycle.create",
  )(function* (input) {
    const sourcePath = yield* projectSource("create", input.projectId);
    const created = yield* operations
      .create({ name: input.name })
      .pipe(Effect.catch((error) => Effect.flip(sanitized("create")(error))));
    return yield* attachProject(created.id, sourcePath, input);
  });

  const attach: DevelopmentEnvironmentLifecycle["Service"]["attach"] = Effect.fn(
    "DevelopmentEnvironmentLifecycle.attach",
  )(function* (input) {
    const sourcePath = yield* projectSource("attach", input.projectId);
    return yield* attachProject(input.xwingEnvironmentId, sourcePath, input);
  });

  const passThrough =
    <I, A>(
      operation: DevelopmentEnvironmentLifecycleOperation,
      id: (input: I) => string,
      run: (input: I) => Effect.Effect<A, XwingOperationError>,
    ) =>
    (input: I): Failure<A> =>
      run(input).pipe(
        Effect.catch((error) => Effect.flip(sanitized(operation, id(input))(error))),
        Effect.withSpan(`DevelopmentEnvironmentLifecycle.${operation}`),
      );

  const repair = passThrough(
    "repair",
    (input: DevelopmentEnvironmentRef) => input.xwingEnvironmentId,
    (input) => operations.repair({ id: input.xwingEnvironmentId }),
  );
  const listAppCommands = passThrough(
    "list-app-commands",
    (input: DevelopmentEnvironmentAppCommandsInput) => input.xwingEnvironmentId,
    (input) =>
      operations.listAppCommands({
        id: input.xwingEnvironmentId,
        repository: input.repository,
      }),
  );
  const startApp = passThrough(
    "start-app",
    (input: DevelopmentEnvironmentStartAppInput) => input.xwingEnvironmentId,
    (input) =>
      operations.startApp({
        id: input.xwingEnvironmentId,
        repository: input.repository,
        ...(input.command === undefined ? {} : { command: input.command }),
      }),
  );
  const stopApp = passThrough(
    "stop-app",
    (input: DevelopmentEnvironmentStopAppInput) => input.xwingEnvironmentId,
    (input) => operations.stopApp({ id: input.xwingEnvironmentId, runId: input.runId }),
  );
  const readAppLogs = passThrough(
    "read-app-logs",
    (input: DevelopmentEnvironmentAppLogsInput) => input.xwingEnvironmentId,
    (input) =>
      operations.readAppLogs({
        id: input.xwingEnvironmentId,
        runId: input.runId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
  );

  const within = (root: string, target: string | null) => {
    if (target === null) return false;
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const scheduleTarget = (
    strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ): string | null => {
    switch (strategy.type) {
      case "existing_worktree":
        return strategy.worktreePath;
      case "root":
      case "worktree":
        return null;
    }
  };

  const threadBlock = Effect.fn("DevelopmentEnvironmentLifecycle.threadBlock")(function* (
    records: ProjectionStore.ProjectionRecords<
      "runs" | "runtimeRequests" | "providerSessions" | "providerThreads"
    >,
    operation: DevelopmentEnvironmentLifecycleOperation,
    id: XwingEnvironmentId,
  ) {
    const { thread } = records;
    if (threadHasUnfinishedWork(records)) return "working" as const;
    if (
      thread.rollbackRequestId !== undefined &&
      (yield* outbox
        .listByCommandId(thread.rollbackRequestId)
        .pipe(Effect.catch((cause) => Effect.flip(unreadable(operation, id)(cause))))).some(
        (effect) =>
          effect.request.type === "provider-thread.rollback" &&
          (effect.status === "pending" || effect.status === "running"),
      )
    )
      return "working" as const;
    for (const session of records.providerSessions) {
      if (session.status === "stopped" || session.status === "error") continue;
      if (
        yield* providerSessionHasBackgroundWork(providerSessions, session, records.providerThreads)
      ) {
        return "background-work" as const;
      }
    }
    if (
      yield* terminals.hasForegroundWork({
        threadId: thread.id,
        worktreePath: thread.worktreePath,
      })
    ) {
      return "terminal-command" as const;
    }
    return thread.archivedAt === null && thread.settledAt === null ? ("unsettled" as const) : null;
  });

  const assess = Effect.fn("DevelopmentEnvironmentLifecycle.assess")(function* (
    operation: DevelopmentEnvironmentLifecycleOperation,
    id: XwingEnvironmentId,
  ) {
    const preview = yield* operations
      .previewCleanup({ id })
      .pipe(Effect.catch((error) => Effect.flip(sanitized(operation, id)(error))));
    const owner = yield* holds.owner;
    const usage = yield* projections
      .listDevelopmentEnvironmentUsage({ xwingEnvironmentId: id })
      .pipe(Effect.catch((cause) => Effect.flip(unreadable(operation, id)(cause))));
    const working = yield* projections
      .getThreadWorktreePaths({ includeArchived: true, includeProjectRoots: true })
      .pipe(Effect.catch((cause) => Effect.flip(unreadable(operation, id)(cause))));
    const usageByThread = new Map<ThreadId, (typeof usage)[number]>();
    for (const row of usage) {
      const seen = usageByThread.get(row.threadId);
      if (seen === undefined || (row.current && !seen.current))
        usageByThread.set(row.threadId, row);
    }
    const threadIds = [
      ...new Set([
        ...usageByThread.keys(),
        ...working
          .filter((entry) => within(preview.rootPath, entry.worktreePath))
          .map((entry) => entry.threadId),
      ]),
    ];
    const threads = (yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const records = yield* projections
            .getThreadRecords(
              threadId,
              ["runs", "runtimeRequests", "providerSessions", "providerThreads"],
              { turnItemTypes: [] },
            )
            .pipe(Effect.catch((cause) => Effect.flip(unreadable(operation, id)(cause))));
          const { thread } = records;
          if (thread.deletedAt !== null) return null;
          const recorded = usageByThread.get(threadId);
          const cwd = working.find((entry) => entry.threadId === threadId)?.worktreePath;
          const current =
            within(preview.rootPath, cwd ?? thread.worktreePath) ||
            thread.developmentEnvironment?.xwingEnvironmentId === id ||
            (thread.linkedDevelopmentEnvironments ?? []).some(
              (environment) =>
                environment.xwingEnvironmentId === id && environment.releasedAt === undefined,
            );
          const block: DevelopmentEnvironmentThreadBlock | null = current
            ? yield* threadBlock(records, operation, id)
            : null;
          return {
            threadId,
            projectId: thread.projectId,
            title: thread.title,
            current,
            archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
            settledAt: thread.settledAt === null ? null : DateTime.formatIso(thread.settledAt),
            lastSelectedAt: recorded?.lastSelectedAt ?? null,
            block,
          } satisfies DevelopmentEnvironmentCleanupThread;
        }),
      { concurrency: 4 },
    )).filter((thread) => thread !== null);
    const currentThreadIds = new Set(
      threads.filter((thread) => thread.current).map((thread) => thread.threadId),
    );
    const { tasks } = yield* schedules
      .list()
      .pipe(Effect.catch((cause) => Effect.flip(unreadable(operation, id)(cause))));
    const blockingSchedules = tasks
      .filter(
        (task) =>
          task.enabled &&
          ((task.threadId !== null && currentThreadIds.has(task.threadId)) ||
            within(preview.rootPath, scheduleTarget(task.workspaceStrategy))),
      )
      .map((task) => ({
        scheduledTaskId: task.id,
        title: task.title,
        threadId: task.threadId,
      }));
    const knownThreadIds = threads.map((thread) => thread.threadId);
    const toHold = (hold: (typeof preview.holds)[number]): DevelopmentEnvironmentCleanupHold => ({
      owner: hold.owner,
      key: hold.key,
      label: hold.label,
      threadId:
        hold.owner === owner
          ? DevelopmentEnvironmentHolds.holdThread(hold.key, knownThreadIds)
          : null,
    });
    const ownHolds = preview.holds.filter((hold) => hold.owner === owner).map(toHold);
    const foreignHolds = preview.holds.filter((hold) => hold.owner !== owner).map(toHold);
    // Hold lines are classified above; an unrecognized line keeps blocking.
    const xwingBlockers = preview.blockers.filter(
      (line) =>
        !preview.holds.some((hold) => line.startsWith(`held by ${hold.owner} ${hold.key} `)),
    );
    const runningApps = yield* catalog.inspect(id).pipe(
      Effect.map((detail) =>
        detail.applications.runs.filter((run) => RUNNING_APP_STATUSES.has(run.status)),
      ),
      // Archived environments have no live apps to inspect.
      Effect.orElseSucceed((): ReadonlyArray<XwingApplicationRun> => []),
    );
    const canClean =
      threads.every((thread) => thread.block === null) &&
      blockingSchedules.length === 0 &&
      foreignHolds.length === 0 &&
      xwingBlockers.length === 0;
    // One fact per line; Xwing's values are single lines.
    const facts = [
      ...threads.map((thread) => `thread ${thread.threadId} ${thread.current} ${thread.block}`),
      ...blockingSchedules.map((task) => `schedule ${task.scheduledTaskId}`),
      ...preview.holds.map((hold) => `hold ${hold.owner} ${hold.key}`).sort(),
      ...[...xwingBlockers].sort().map((line) => `blocker ${line}`),
      ...preview.worktrees.map(
        (tree) => `worktree ${tree.path} ${tree.dirty} ${tree.untracked} ${tree.ignored}`,
      ),
      ...runningApps.map((run) => `app ${run.id}`).sort(),
    ];
    const fingerprint = NodeCrypto.createHash("sha256").update(facts.join("\n")).digest("hex");
    return {
      assessment: {
        xwingEnvironmentId: preview.environmentId,
        ...(preview.number === undefined ? {} : { number: preview.number }),
        name: preview.name,
        rootPath: preview.rootPath,
        assessedAt: DateTime.formatIso(yield* DateTime.now),
        fingerprint,
        canClean,
        threads,
        schedules: blockingSchedules,
        ownHolds,
        foreignHolds,
        xwingBlockers,
        worktrees: preview.worktrees,
        runningApps,
        retainedPaths: preview.retainedPaths,
      } satisfies DevelopmentEnvironmentCleanupAssessment,
      previewHolds: preview.holds,
      leasePaths: [
        ...new Set([
          ...preview.worktrees.map((tree) => path.resolve(tree.path)),
          ...working
            .filter((entry) => currentThreadIds.has(entry.threadId))
            .map((entry) => path.resolve(entry.worktreePath)),
        ]),
      ].sort(),
    };
  });

  const assessCleanup: DevelopmentEnvironmentLifecycle["Service"]["assessCleanup"] = (input) =>
    assess("assess-cleanup", input.xwingEnvironmentId).pipe(
      Effect.map(({ assessment }) => assessment),
      Effect.withSpan("DevelopmentEnvironmentLifecycle.assessCleanup"),
    );

  const cleanUp: DevelopmentEnvironmentLifecycle["Service"]["cleanUp"] = Effect.fn(
    "DevelopmentEnvironmentLifecycle.cleanUp",
  )(function* (input) {
    const id = input.xwingEnvironmentId;
    return yield* holds.exclusive(
      id,
      Effect.gen(function* () {
        const initial = yield* assess("clean-up", id);
        return yield* initial.leasePaths.reduceRight(
          (effect, cwd) => withWorkspaceLease(cwd, effect),
          Effect.gen(function* () {
            const { assessment, previewHolds } = yield* assess("clean-up", id);
            if (assessment.fingerprint !== input.fingerprint) {
              return yield* lifecycleError("clean-up", "assessment-changed", id);
            }
            if (!assessment.canClean)
              return yield* lifecycleError("clean-up", "cleanup-blocked", id);
            const released: Array<(typeof previewHolds)[number]> = [];
            // Restores released holds when deletion does not happen, so a refused cleanup leaves the
            // environment held exactly as before.
            const restore = Effect.forEach(
              previewHolds.filter((hold) =>
                assessment.ownHolds.some((own) => own.key === hold.key && own.owner === hold.owner),
              ),
              (hold) =>
                operations
                  .registerHold({
                    id,
                    owner: hold.owner,
                    key: hold.key,
                    label: hold.label,
                    ...(hold.detail === undefined ? {} : { detail: hold.detail }),
                  })
                  .pipe(
                    Effect.tapError((cause) =>
                      Effect.logWarning(
                        "Xwing did not restore a development environment hold",
                        cause,
                      ),
                    ),
                    Effect.ignore,
                  ),
              { discard: true },
            );
            const deleted = yield* Effect.gen(function* () {
              for (const hold of previewHolds) {
                if (
                  !assessment.ownHolds.some(
                    (own) => own.key === hold.key && own.owner === hold.owner,
                  )
                ) {
                  continue;
                }
                yield* operations.releaseHold({
                  id,
                  owner: hold.owner,
                  key: hold.key,
                });
                released.push(hold);
              }
              const refreshed = yield* assess("clean-up", id);
              if (!refreshed.assessment.canClean) {
                return yield* lifecycleError("clean-up", "assessment-changed", id);
              }
              if (input.action === "delete") return yield* operations.delete({ id, confirmId: id });
              const archived = yield* operations.archive({ id });
              return {
                outcome: archived.outcome,
                stoppedApplications: assessment.runningApps,
                retainedPaths: [archived.archivePath],
              };
            }).pipe(
              Effect.onExit((exit) => (Exit.isFailure(exit) ? restore : Effect.void)),
              Effect.catch((error) =>
                error._tag === "DevelopmentEnvironmentLifecycleError"
                  ? error
                  : Effect.flip(sanitized("clean-up", id)(error)),
              ),
            );
            return {
              xwingEnvironmentId: id,
              outcome: deleted.outcome,
              releasedHolds: released.map((hold) => hold.key),
              stoppedApplications: deleted.stoppedApplications.map((app) => app.name),
              retainedPaths: deleted.retainedPaths,
            } satisfies DevelopmentEnvironmentCleanUpResult;
          }),
        );
      }),
    );
  });

  const restore: DevelopmentEnvironmentLifecycle["Service"]["restore"] = Effect.fn(
    "DevelopmentEnvironmentLifecycle.restore",
  )(function* (input) {
    return yield* holds.exclusive(
      input.xwingEnvironmentId,
      operations
        .restore({ id: input.xwingEnvironmentId })
        .pipe(
          Effect.catch((error) =>
            Effect.flip(sanitized("restore", input.xwingEnvironmentId)(error)),
          ),
        ),
    );
  });

  const gitStdout = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation, cwd, args, allowNonZeroExit: true, timeoutMs: 5_000 }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );

  // Matches ThreadLaunchService: the base branch's upstream, else the same name on origin.
  const launchBase = Effect.fn("DevelopmentEnvironmentLifecycle.launchBase")(function* (
    sourcePath: string,
    baseRef: string,
    startFromOrigin: boolean,
  ) {
    // An option-like ref goes on unchanged; Xwing's base validation refuses it.
    if (!startFromOrigin || baseRef.startsWith("-")) return baseRef;
    const upstream = yield* gitStdout(
      "DevelopmentEnvironmentLifecycle.launchBase.upstream",
      sourcePath,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${baseRef}@{upstream}`],
    );
    if (upstream !== "") return upstream;
    const onOrigin = yield* gitStdout(
      "DevelopmentEnvironmentLifecycle.launchBase.origin",
      sourcePath,
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseRef}`],
    );
    return onOrigin === "" ? baseRef : `origin/${baseRef}`;
  });

  const prepareLaunch: DevelopmentEnvironmentLifecycle["Service"]["prepareLaunch"] = Effect.fn(
    "DevelopmentEnvironmentLifecycle.prepareLaunch",
  )(function* (input) {
    const sourcePath = yield* projectSource("create", input.projectId);
    const key = NodeCrypto.createHash("sha256").update(input.launchKey).digest("hex").slice(0, 8);
    const marker = `[t3 ${key}]`;
    const branch =
      input.branch ??
      `${WORKTREE_BRANCH_PREFIX}/${sanitizeBranchFragment(input.title).slice(0, 40)}-${key}`;
    const attachLaunch = (id: XwingEnvironmentId) =>
      launchBase(sourcePath, input.baseRef, input.startFromOrigin).pipe(
        Effect.flatMap((base) => attachProject(id, sourcePath, { branch, base })),
      );
    // Exit 1 is git's "no such ref"; any other outcome leaves the branch's absence unproven.
    const branchAbsent = git
      .execute({
        operation: "DevelopmentEnvironmentLifecycle.prepareLaunch.branch",
        cwd: sourcePath,
        args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => result.exitCode === 1),
        Effect.orElseSucceed(() => false),
      );
    const existing = yield* catalog.list().pipe(
      Effect.map((environments) =>
        environments.find(
          (environment) => environment.status === "active" && environment.name.endsWith(marker),
        ),
      ),
      Effect.catch((cause) => Effect.flip(unreadable("create", "")(cause))),
    );
    if (existing !== undefined) {
      const attached = existing.repositories.some(
        (repository) => path.resolve(repository.sourcePath) === path.resolve(sourcePath),
      );
      const result = attached ? null : yield* attachLaunch(existing.id);
      if (result?.failure != null)
        return yield* lifecycleError("attach", result.failure.reason, existing.id);
      return { xwingEnvironmentId: existing.id, created: false };
    }
    const title = input.title.replace(/\s+/g, " ").trim() || "T3 thread";
    const created = yield* operations
      .create({ name: `${title.slice(0, 180)} ${marker}` })
      .pipe(Effect.catch((error) => Effect.flip(sanitized("create")(error))));
    const branchWasAbsent = yield* branchAbsent;
    const result = yield* attachLaunch(created.id);
    if (result.failure !== null) {
      yield* operations
        .delete({ id: created.id, confirmId: created.id })
        .pipe(Effect.ignore({ log: true }));
      return yield* lifecycleError("attach", result.failure.reason, created.id);
    }
    // The commit Xwing started the branch from, so a commit a checkout hook or setup made during
    // the attach keeps the branch.
    const tip = branchWasAbsent ? result.repository?.baseRevision : undefined;
    return {
      xwingEnvironmentId: created.id,
      created: true,
      ...(tip === undefined || tip === "" ? {} : { newBranch: { sourcePath, name: branch, tip } }),
    };
  });

  // Never fails: a branch it cannot prove unused and unchanged is kept and logged.
  const deleteLaunchBranch = Effect.fn("DevelopmentEnvironmentLifecycle.deleteLaunchBranch")(
    function* (branch: LaunchBranch) {
      const ref = `refs/heads/${branch.name}`;
      const checkouts = yield* git
        .execute({
          operation: "DevelopmentEnvironmentLifecycle.deleteLaunchBranch.worktrees",
          cwd: branch.sourcePath,
          args: ["worktree", "list", "--porcelain"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.option);
      const listed = Option.getOrUndefined(checkouts);
      if (
        listed === undefined ||
        listed.exitCode !== 0 ||
        listed.stdout.split("\n").some((line) => line.trim() === `branch ${ref}`)
      ) {
        return yield* Effect.logInfo("Kept the branch of a failed launch; a checkout may use it", {
          branch: branch.name,
        });
      }
      // Deletes only while the branch still points at its first commit.
      const deleted = yield* git
        .execute({
          operation: "DevelopmentEnvironmentLifecycle.deleteLaunchBranch.delete",
          cwd: branch.sourcePath,
          args: ["update-ref", "-d", ref, branch.tip],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map((result) => result.exitCode === 0),
          Effect.orElseSucceed(() => false),
        );
      if (!deleted) {
        yield* Effect.logInfo("Kept the branch of a failed launch; it has moved", {
          branch: branch.name,
        });
      }
    },
  );

  const discardLaunch: DevelopmentEnvironmentLifecycle["Service"]["discardLaunch"] = Effect.fn(
    "DevelopmentEnvironmentLifecycle.discardLaunch",
  )(function* (input) {
    const id = input.xwingEnvironmentId;
    const owner = yield* holds.owner;
    yield* holds.exclusive(
      id,
      operations.releaseHold({ id, owner, key: holdKey(input.hold) }).pipe(
        Effect.andThen(operations.delete({ id, confirmId: id })),
        Effect.andThen(
          input.newBranch === undefined ? Effect.void : deleteLaunchBranch(input.newBranch),
        ),
        Effect.catch((error) =>
          Effect.logWarning(
            "Could not remove the Xwing environment of a failed launch",
            error,
          ).pipe(Effect.annotateLogs({ xwingEnvironmentId: id })),
        ),
      ),
    );
  });

  return DevelopmentEnvironmentLifecycle.of({
    prepareLaunch,
    discardLaunch,
    create,
    attach,
    repair,
    restore,
    listAppCommands,
    startApp,
    stopApp,
    readAppLogs,
    assessCleanup,
    cleanUp,
  });
});

export const layer = Layer.effect(DevelopmentEnvironmentLifecycle, make);
