import {
  CommandId,
  type GitCommandError,
  MessageId,
  type ProjectId,
  type ThreadId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";

import * as DevelopmentEnvironmentLifecycle from "../developmentEnvironments/DevelopmentEnvironmentLifecycle.ts";
import * as DevelopmentEnvironments from "../developmentEnvironments/DevelopmentEnvironments.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { dispatchWasNotAccepted } from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readWorktreeProvider, worktreeProviderRefusal } from "../git/worktreeProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    /** The agent tool: moves the calling thread, which may be mid-turn, into a new worktree. */
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    /**
     * A person's request: moves a stopped thread into a new worktree through the same steps as
     * `handoff`, without queueing a continuation.
     */
    readonly handoffThread: (
      threadId: ThreadId,
      input: Omit<WorktreeMcpHandoffInput, "continuationPrompt">,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
    readonly listRefs: (
      input: Omit<VcsListRefsInput, "cwd"> & {
        readonly worktreePath: string | null;
        readonly workspaceRoot: string;
      },
    ) => Effect.Effect<VcsListRefsResult, GitCommandError | PlatformError.PlatformError>;
  }
>()("t3/mcp/WorktreeMcpService") {}

/** The thread a handoff moves, where its command ids come from, and whether an agent asked. */
interface HandoffTarget {
  readonly threadId: ThreadId;
  readonly idSource: ReadonlyArray<string>;
  readonly agent: boolean;
}

function failure(code: WorktreeMcpFailure["code"], message: string): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

const isWorktreeMcpFailure = Schema.is(WorktreeMcpFailure);

/** What a failed handoff could not remove, for the person to remove by hand. */
function leftovers(worktreePath: string | null, branch: string): string {
  return worktreePath === null
    ? `branch '${branch}'`
    : `the worktree at '${worktreePath}' and branch '${branch}'`;
}

/**
 * When `effect` fails, removes what it created and fails as it did. Interruption alone removes
 * nothing, because a thread binding may already have committed. A removal that fails is named in
 * the error, so the caller can remove what is left.
 */
const undoOnFailure =
  <E>(undo: Effect.Effect<void, E>, describe: () => string) =>
  <A, R>(effect: Effect.Effect<A, WorktreeMcpFailure, R>) =>
    effect.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          undo.pipe(
            Effect.matchCauseEffect({
              onSuccess: () => Effect.failCause(cause),
              onFailure: (undoCause) => {
                const original = Cause.squash(cause);
                const note = `Could not remove ${describe()}: ${errorMessage(Cause.squash(undoCause))}. Remove them by hand before retrying.`;
                return Effect.logWarning("Could not undo a failed worktree handoff", {
                  left: describe(),
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      isWorktreeMcpFailure(original)
                        ? failure(original.code, `${original.message} ${note}`)
                        : failure("operation_failed", `${errorMessage(original)} ${note}`),
                    ),
                  ),
                );
              },
            }),
          ),
      ),
    );

const asOperationFailed = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${prefix}: ${errorMessage(error)}`),
  );

/** Whether the continuation committed with the binding started its run or waits behind one. */
function continuationStatus(
  input: WorktreeMcpHandoffInput,
  bound: Orchestrator.OrchestratorV2DispatchResult,
): WorktreeMcpContinuationStatus {
  if (input.continuationPrompt === undefined) return { status: "skipped" };
  return {
    status: "scheduled",
    delivery: bound.storedEvents.some(
      ({ event }) => event.type === "run.created" && event.payload.status !== "queued",
    )
      ? "started"
      : "queued",
  };
}

function handoffNote(
  continuation: WorktreeMcpContinuationStatus,
  checkout: "worktree" | "Xwing environment",
): string {
  const resume =
    continuation.status === "scheduled"
      ? `the queued continuation prompt then starts the next turn inside the ${checkout} with the conversation preserved.`
      : `the conversation continues inside the ${checkout} when the thread receives its next message. Pass continuationPrompt to resume automatically.`;
  const lifetime =
    checkout === "worktree"
      ? "The worktree is not removed automatically when the thread is deleted."
      : "The Xwing environment stays until it is cleaned up through T3 or Xwing; deleting the thread does not remove it.";
  return `Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; ${resume} ${lifetime}`;
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const environmentLifecycle =
    yield* DevelopmentEnvironmentLifecycle.DevelopmentEnvironmentLifecycle;
  const developmentEnvironments = yield* DevelopmentEnvironments.DevelopmentEnvironments;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;

  // Serialize handoffs per thread to avoid creating two worktrees and orphaning one.
  const handoffThreadsInFlight = new Set<string>();

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree handoff and status act as the calling T3 thread, so they need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, []).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${threadId}' was not found.`),
      ),
    );

  const loadProject = (threadId: ThreadId, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = (projectId: ProjectId) =>
    serverSettings.getSettings.pipe(
      Effect.map(
        (settings) =>
          resolveProjectSettings(settings, projectId).settings.newWorktreesStartFromOrigin,
      ),
      asOperationFailed("Unable to read server settings"),
    );

  const handoffIds = (target: HandoffTarget) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, ...target.idSource, operation, uuid].join(":");
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  const performHandoff = Effect.fn("WorktreeMcpService.performHandoff")(function* (
    target: HandoffTarget,
    input: WorktreeMcpHandoffInput,
    worktreeProvider: "t3" | "xwing",
  ) {
    const alreadyInWorktree = (worktreePath: string) =>
      failure(
        "already_in_worktree",
        `Thread '${target.threadId}' is already attached to worktree '${worktreePath}'.`,
      );

    const projection = yield* loadThread(target.threadId);
    if (projection.thread.worktreePath !== null) {
      return yield* alreadyInWorktree(projection.thread.worktreePath);
    }
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${target.threadId}' is archived and cannot be handed off to a worktree.`,
      );
    }

    const project = yield* loadProject(target.threadId, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;

    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(asOperationFailed("Unable to read git status"));
    if (!localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${projectCwd}' is not a git repository.`,
      );
    }

    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(projectCwd)
      .pipe(asOperationFailed("Unable to list branches"));
    if (localBranchNames.includes(input.branch)) {
      const existingRef = yield* gitWorkflow
        .listRefs({ cwd: projectCwd, query: input.branch, refKind: "local" })
        .pipe(
          Effect.map((result) =>
            result.refs.find((ref) => ref.name === input.branch && ref.isRemote !== true),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const checkoutPath = existingRef?.worktreePath ?? null;
      return yield* failure(
        "invalid_request",
        `Branch '${input.branch}' already exists${
          checkoutPath === null ? "" : ` and is checked out at '${checkoutPath}'`
        }. Choose a different branch name, or delete the existing branch${
          checkoutPath === null ? "" : " and its worktree"
        } first.`,
      );
    }

    let baseRef = input.baseRef;
    if (baseRef === undefined) {
      if (localStatus.refName === null) {
        return yield* failure(
          "invalid_request",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
        );
      }
      baseRef = localStatus.refName;
    }

    const startFromOrigin =
      input.startFromOrigin ?? (yield* readDefaultStartFromOrigin(project.id));

    let worktreeBaseRef = baseRef;
    let baseRefName = baseRef;
    let startedFromOrigin = false;
    if (startFromOrigin) {
      const resolvedRemoteBase = yield* gitWorkflow
        .fetchWorktreeBaseCommit({ cwd: projectCwd, refName: baseRef })
        .pipe(asOperationFailed(`Unable to fetch the remote base of '${baseRef}'`));
      if (resolvedRemoteBase !== null) {
        worktreeBaseRef = resolvedRemoteBase.commitSha;
        baseRefName = `refs/remotes/${resolvedRemoteBase.remoteRefName}`;
        startedFromOrigin = true;
      }
    }

    const ids = yield* handoffIds(target);

    // A concurrent UI binding may have landed meanwhile; do not orphan a second checkout.
    const recheck = Effect.fn("WorktreeMcpService.recheck")(function* (checkout: string) {
      const current = yield* loadThread(target.threadId);
      if (current.thread.worktreePath !== null) {
        return yield* alreadyInWorktree(current.thread.worktreePath);
      }
      if (current.thread.archivedAt !== null) {
        return yield* failure(
          "invalid_request",
          `Thread '${target.threadId}' was archived while the ${checkout} was being created; the handoff was rolled back.`,
        );
      }
    });

    const asBindFailure = <A, E, R>(dispatch: Effect.Effect<A, E, R>) =>
      dispatch.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(
                failure(
                  "operation_failed",
                  `Unable to re-point the thread at the ${worktreeProvider === "t3" ? "worktree" : "Xwing environment"}: ${errorMessage(Cause.squash(cause))}`,
                ),
              ),
        ),
      );

    // Only an agent handing off from its own turn may move a thread that is not stopped. Binding
    // detaches the session and ends the caller, so the continuation commits with it.
    const bindingFields = {
      ...(target.agent ? { workspaceChange: "agent-handoff" as const } : {}),
      ...(input.continuationPrompt === undefined
        ? {}
        : {
            continuation: {
              messageId: ids.continuationMessageId,
              text: input.continuationPrompt,
            },
          }),
    };

    if (worktreeProvider === "xwing") {
      // Xwing resolves a ref name itself and can land elsewhere, so it gets the commit.
      const baseCommit = startedFromOrigin
        ? worktreeBaseRef
        : baseRef.startsWith("-")
          ? yield* failure("invalid_request", `Base '${baseRef}' is not a valid ref.`)
          : (yield* gitDriver
              .resolveCommit({ cwd: projectCwd, revision: baseRef })
              .pipe(
                Effect.mapError(() =>
                  failure(
                    "invalid_request",
                    `Base '${baseRef}' does not name a commit in the project repository.`,
                  ),
                ),
              )).commitSha;
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prepared = yield* restore(
            environmentLifecycle.prepareLaunch({
              projectId: project.id,
              launchKey: ids.commandId,
              title: projection.thread.title,
              branch: input.branch,
              baseRef: baseCommit,
              startFromOrigin: false,
            }),
          ).pipe(asOperationFailed("Unable to create the Xwing environment"));
          const hold = { threadId: target.threadId, period: ids.commandId };
          // Only a failure proven to precede the binding's commit may remove the environment.
          let bindAttempted = false;
          let bindRefused = false;
          const bound = yield* Effect.gen(function* () {
            const workspace = yield* developmentEnvironments
              .resolveLaunchWorkspace({
                projectId: project.id,
                xwingEnvironmentId: prepared.xwingEnvironmentId,
              })
              .pipe(asOperationFailed("Unable to resolve the Xwing environment's checkout"));
            yield* recheck("Xwing environment");
            bindAttempted = true;
            const dispatched = yield* developmentEnvironments
              .bindLaunch(
                {
                  xwingEnvironmentId: prepared.xwingEnvironmentId,
                  threadId: target.threadId,
                  commandId: ids.commandId,
                  title: projection.thread.title,
                },
                threadManagement.dispatch({
                  type: "thread.workspace.select",
                  commandId: ids.commandId,
                  threadId: target.threadId,
                  expected: {
                    projectId: project.id,
                    worktreePath: null,
                    xwingEnvironmentId:
                      projection.thread.developmentEnvironment?.xwingEnvironmentId ?? null,
                  },
                  worktreePath: workspace.workspaceStrategy.worktreePath,
                  branch: workspace.workspaceStrategy.branch ?? input.branch,
                  developmentEnvironment: workspace.developmentEnvironment,
                  ...bindingFields,
                }),
              )
              .pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    bindRefused =
                      error._tag === "DevelopmentEnvironmentCheckoutUnavailableError" ||
                      error._tag === "OrchestratorWorkspaceSelectionRejectedError" ||
                      dispatchWasNotAccepted(error);
                  }),
                ),
                asBindFailure,
              );
            return { workspace, dispatched };
          }).pipe(
            Effect.catchCauseIf(
              (cause) => prepared.created && !Cause.hasInterruptsOnly(cause),
              (cause) => {
                if (!bindAttempted || bindRefused) {
                  return environmentLifecycle
                    .discardLaunch({
                      xwingEnvironmentId: prepared.xwingEnvironmentId,
                      hold,
                      newBranch: prepared.newBranch,
                    })
                    .pipe(Effect.andThen(Effect.failCause(cause)));
                }
                const original = Cause.squash(cause);
                const kept = `The thread may already be bound to it, so Xwing environment ${prepared.xwingEnvironmentId} and its hold were kept; check the thread before cleaning the environment up.`;
                return Effect.logWarning("Kept the Xwing environment of an ambiguous handoff", {
                  threadId: target.threadId,
                  xwingEnvironmentId: prepared.xwingEnvironmentId,
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      isWorktreeMcpFailure(original)
                        ? failure(original.code, `${original.message} ${kept}`)
                        : failure("operation_failed", `${errorMessage(original)} ${kept}`),
                    ),
                  ),
                );
              },
            ),
          );
          const worktreePath = bound.workspace.workspaceStrategy.worktreePath;
          yield* vcsStatusBroadcaster
            .refreshStatus(worktreePath)
            .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
          const continuation = continuationStatus(input, bound.dispatched);
          const result: WorktreeMcpHandoffResult = {
            worktreePath,
            branch: bound.workspace.workspaceStrategy.branch ?? input.branch,
            baseRef,
            startedFromOrigin,
            // Xwing runs the environment's installs, so T3's setup script does not run here.
            setupScript: { status: "skipped" },
            continuation,
            note: handoffNote(continuation, "Xwing environment"),
          };
          return result;
        }),
      );
    }

    // Mask interruption after worktree creation through setup; binding can detach and interrupt the caller.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // The branch did not exist before this call (checked above), so a branch of that name and
        // its checkout after a failed create are this call's: Git keeps a worktree whose checkout
        // hook failed, and its branch with it.
        let failedCheckoutPath: string | null = null;
        const removeFailedCreation = Effect.gen(function* () {
          const created = (yield* gitWorkflow.listRefs({
            cwd: projectCwd,
            query: input.branch,
            refKind: "local",
          })).refs.find((ref) => ref.name === input.branch && ref.isRemote !== true);
          if (created === undefined) return;
          failedCheckoutPath = created.worktreePath ?? null;
          if (failedCheckoutPath !== null) {
            yield* gitWorkflow.removeWorktree({
              cwd: projectCwd,
              path: failedCheckoutPath,
              force: true,
            });
          }
          yield* gitWorkflow.deleteLocalBranch({
            cwd: projectCwd,
            refName: input.branch,
            force: true,
          });
        });
        const worktree = yield* restore(
          gitWorkflow
            .createWorktree({
              cwd: projectCwd,
              refName: worktreeBaseRef,
              newRefName: input.branch,
              baseRefName,
              path: null,
            })
            .pipe(
              asOperationFailed("Unable to create the worktree"),
              undoOnFailure(removeFailedCreation, () =>
                leftovers(failedCheckoutPath, input.branch),
              ),
            ),
        );
        const worktreePath = worktree.worktree.path;

        const reportFailed = (logMessage: string) =>
          Effect.catchCause((cause: Cause.Cause<unknown>) => {
            const detail = errorMessage(Cause.squash(cause));
            return Effect.logWarning(logMessage, {
              threadId: target.threadId,
              worktreePath,
              detail,
            }).pipe(Effect.as({ status: "failed", detail } as const));
          });

        const removeCreatedWorktree = Effect.suspend(() =>
          gitWorkflow.removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }),
        ).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              gitWorkflow.deleteLocalBranch({
                cwd: projectCwd,
                refName: worktree.worktree.refName,
                force: true,
              }),
            ),
          ),
        );

        const recheckAndBind = recheck("worktree").pipe(
          Effect.andThen(() =>
            threadManagement
              .dispatch({
                type: "thread.metadata.update",
                commandId: ids.commandId,
                threadId: target.threadId,
                branch: worktree.worktree.refName,
                worktreePath,
                expectedWorktreePath: null,
                ...bindingFields,
              })
              .pipe(asBindFailure),
          ),
          undoOnFailure(removeCreatedWorktree, () =>
            leftovers(worktreePath, worktree.worktree.refName),
          ),
        );

        const bound = yield* recheckAndBind;
        const continuation = continuationStatus(input, bound);

        yield* vcsStatusBroadcaster
          .refreshStatus(worktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        if (input.runSetupScript ?? true) {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: target.threadId,
              projectId: projection.thread.projectId,
              projectCwd,
              worktreePath,
              project: {
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
                result.status === "started"
                  ? {
                      status: "started",
                      scriptName: result.scriptName,
                      terminalId: result.terminalId,
                    }
                  : result.status === "skipped-for-link"
                    ? { status: "skipped" }
                    : { status: "no-script" },
              ),
              reportFailed("worktree handoff setup script failed"),
            );
        }

        const result: WorktreeMcpHandoffResult = {
          worktreePath,
          branch: worktree.worktree.refName,
          baseRef,
          startedFromOrigin,
          setupScript,
          continuation,
          note: handoffNote(continuation, "worktree"),
        };
        return result;
      }),
    );
  });

  // Serialize per thread and refuse when the server allows no isolated checkouts, for both callers.
  const runHandoff = Effect.fn("WorktreeMcpService.runHandoff")(function* (
    target: HandoffTarget,
    input: WorktreeMcpHandoffInput,
  ) {
    const worktreeProvider = yield* readWorktreeProvider(serverSettings);
    if (worktreeProvider === "off") {
      return yield* failure("invalid_request", worktreeProviderRefusal(worktreeProvider));
    }
    // Acquire and register cleanup atomically so cancellation cannot strand the guard until restart.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (handoffThreadsInFlight.has(target.threadId)) {
          return Effect.fail(
            failure(
              "handoff_in_progress",
              `A worktree handoff is already in progress for thread '${target.threadId}'.`,
            ),
          );
        }
        handoffThreadsInFlight.add(target.threadId);
        return restore(performHandoff(target, input, worktreeProvider)).pipe(
          Effect.ensuring(Effect.sync(() => handoffThreadsInFlight.delete(target.threadId))),
        );
      }),
    );
  });

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      return yield* runHandoff(
        {
          threadId: scope.thread.threadId,
          idSource: ["mcp", encodeURIComponent(scope.thread.providerSessionId)],
          agent: true,
        },
        input,
      );
    },
  );

  const handoffThread: WorktreeMcpService["Service"]["handoffThread"] = Effect.fn(
    "WorktreeMcpService.handoffThread",
  )(function* (threadId, input) {
    return yield* runHandoff({ threadId, idSource: ["client"], agent: false }, input);
  });

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const projection = yield* loadThread(scope.thread.threadId);
      const project = yield* loadProject(scope.thread.threadId, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin(project.id);

      const result: WorktreeMcpStatusResult = {
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
      };
      return result;
    },
  );

  const listRefs: WorktreeMcpService["Service"]["listRefs"] = Effect.fn(
    "WorktreeMcpService.listRefs",
  )(function* ({ worktreePath, workspaceRoot, ...refs }) {
    // Storage cleanup removes a worktree but keeps its path on the thread.
    const cwd =
      worktreePath !== null && (yield* fileSystem.exists(worktreePath))
        ? worktreePath
        : workspaceRoot;
    return yield* gitWorkflow.listRefs({ ...refs, cwd });
  });

  return WorktreeMcpService.of({ handoff, handoffThread, status, listRefs });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
  | DevelopmentEnvironmentLifecycle.DevelopmentEnvironmentLifecycle
  | DevelopmentEnvironments.DevelopmentEnvironments
  | GitVcsDriver.GitVcsDriver
> = Layer.effect(WorktreeMcpService, make);
