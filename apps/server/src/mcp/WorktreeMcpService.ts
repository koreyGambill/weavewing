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

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readWorktreeProvider, worktreeProviderRefusal } from "../git/worktreeProvider.ts";
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

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

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

        const recheckAndBind = Effect.gen(function* () {
          // A concurrent UI binding may have landed during git work; do not orphan a second worktree.
          const recheck = yield* loadThread(target.threadId);
          if (recheck.thread.worktreePath !== null) {
            return yield* alreadyInWorktree(recheck.thread.worktreePath);
          }
          if (recheck.thread.archivedAt !== null) {
            return yield* failure(
              "invalid_request",
              `Thread '${target.threadId}' was archived while the worktree was being created; the handoff was rolled back.`,
            );
          }
          return yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: target.threadId,
              branch: worktree.worktree.refName,
              worktreePath,
              expectedWorktreePath: null,
              // Only an agent handing off from its own turn may move a thread that is not stopped.
              ...(target.agent ? { workspaceChange: "agent-handoff" as const } : {}),
              // Binding detaches the session and ends the caller; a later send could lose the race.
              ...(input.continuationPrompt === undefined
                ? {}
                : {
                    continuation: {
                      messageId: ids.continuationMessageId,
                      text: input.continuationPrompt,
                    },
                  }),
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.fail(
                      failure(
                        "operation_failed",
                        `Unable to re-point the thread at the worktree: ${errorMessage(Cause.squash(cause))}`,
                      ),
                    ),
              ),
            );
        }).pipe(
          undoOnFailure(removeCreatedWorktree, () =>
            leftovers(worktreePath, worktree.worktree.refName),
          ),
        );

        const bound = yield* recheckAndBind;
        const continuation: WorktreeMcpContinuationStatus =
          input.continuationPrompt === undefined
            ? { status: "skipped" }
            : {
                status: "scheduled",
                delivery: bound.storedEvents.some(
                  ({ event }) => event.type === "run.created" && event.payload.status !== "queued",
                )
                  ? "started"
                  : "queued",
              };

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
          note:
            continuation.status === "scheduled"
              ? "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the queued continuation prompt then starts the next turn inside the worktree with the conversation preserved. The worktree is not removed automatically when the thread is deleted."
              : "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the conversation continues inside the worktree when the thread receives its next message. Pass continuationPrompt to resume automatically. The worktree is not removed automatically when the thread is deleted.",
        };
        return result;
      }),
    );
  });

  // Serialize per thread and refuse a non-T3 worktree provider, for both callers.
  const runHandoff = Effect.fn("WorktreeMcpService.runHandoff")(function* (
    target: HandoffTarget,
    input: WorktreeMcpHandoffInput,
  ) {
    const worktreeProvider = yield* readWorktreeProvider(serverSettings);
    if (worktreeProvider !== "t3") {
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
        return restore(performHandoff(target, input)).pipe(
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
> = Layer.effect(WorktreeMcpService, make);
