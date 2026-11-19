import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { sanitizeBranchFragment, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import type { ChatAttachment, OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as DevelopmentEnvironmentLifecycle from "../developmentEnvironments/DevelopmentEnvironmentLifecycle.ts";
import * as DevelopmentEnvironments from "../developmentEnvironments/DevelopmentEnvironments.ts";
import { readWorktreeProvider } from "../git/worktreeProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// These failures precede commitCommand; generic dispatch errors can follow commits and remain ambiguous.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "OrchestratorProviderSelectionBusyError":
    case "OrchestratorRuntimeModeAboveCeilingError":
    case "ThreadManagementProviderInstanceDisabledError":
    case "ThreadManagementWorktreeRestoreError":
      return true;
    default:
      return false;
  }
}
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      return path ? [path, `${path}.txt`] : [];
    }),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

/**
 * A guest message goes out with the files the guest attached, never ones a client names. They
 * are already the thread's attachments. A message no longer waiting gets none; the orchestrator
 * then refuses or replays the send.
 */
const withGuestAttachments = Effect.fn("ThreadMessageIntake.withGuestAttachments")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) {
  if (command.guestMessageId === undefined) return command;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Only the thread record is needed; the window keeps the read small.
  const { projection } = yield* threads
    .getThreadSnapshotWindow(command.threadId, { rowLimit: 1 })
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaims.AttachmentClaimError({
            message: "Failed to read the guest message.",
            cause,
          }),
      ),
    );
  const message = projection.thread.guestShare?.messages.find(
    (candidate) => candidate.id === command.guestMessageId && candidate.status === "pending",
  );
  return { ...command, attachments: message?.attachments ?? [] };
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  incoming: OrchestrationV2Command,
) {
  const command =
    incoming.type === "message.dispatch" ? yield* withGuestAttachments(incoming) : incoming;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    const claimedPaths: string[] = [];
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@t3tools/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      const answers = yield* appendUserInputAttachmentPaths({
        answers: command.answers ?? {},
        attachmentsByQuestionId,
        attachmentsDir: config.attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
        ),
      );
      return { answers, attachmentsByQuestionId };
    }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
    return yield* threads
      .dispatch({
        ...command,
        answers: prepared.answers,
        attachmentsByQuestionId: prepared.attachmentsByQuestionId,
      })
      .pipe(
        Effect.tap((result) => {
          // Replayed receipts refer to the first answer; release this attempt's unused copies only with a resolved item.
          // Missing questionAnswer means no accepted attachments; missing resolution leaves delivery ambiguous.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              )
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command);
  // An accepted edit's retry replays its receipt even if a later cleanup removed its files.
  if (command.type === "queued-run.edit" && !(yield* threads.hasReceipt(command.commandId))) {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    // A stale view can keep a file that another client's edit dropped and deleted.
    for (const attachment of command.attachments ?? []) {
      if (AttachmentClaims.attachmentIsPendingUpload(attachment)) continue;
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (
        path !== null &&
        !(yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* new AttachmentClaims.AttachmentClaimError({
          message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
        });
      }
    }
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: command.threadId,
    attachments: command.attachments ?? [],
  });
  return yield* threads
    .dispatch({
      ...command,
      attachments: claimed.attachments,
      ...(command.context
        ? {
            context: remapComposerContextAttachments(
              command.context,
              command.attachments ?? [],
              claimed.attachments,
            ),
          }
        : {}),
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? event.payload.attachments : [],
          ),
        ),
      ),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void,
      ),
    );
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
        : Effect.void,
    ),
  );
});

/**
 * A launch as a client or agent asks for it: it may name an Xwing environment, never a resolved
 * binding, so the checkout always comes from this host's Xwing.
 */
export type ThreadLaunchRequest = Omit<
  ThreadLaunch.ThreadLaunchInput,
  "workspaceStrategy" | "developmentEnvironment"
> & {
  readonly workspaceStrategy:
    | ThreadLaunch.ThreadLaunchWorkspaceStrategy
    | { readonly type: "xwing_environment"; readonly xwingEnvironmentId: string };
};

/**
 * Under `worktreeProvider: "xwing"` an isolated launch gets an Xwing environment of its own. A
 * retried launch reuses the environment its thread was bound to instead of creating another.
 */
const xwingEnvironmentForWorktreeLaunch = Effect.fn(
  "ThreadMessageIntake.xwingEnvironmentForWorktreeLaunch",
)(function* (
  request: ThreadLaunchRequest,
  strategy: Extract<ThreadLaunch.ThreadLaunchWorkspaceStrategy, { readonly type: "worktree" }>,
) {
  if (request.threadId !== undefined) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const existing = yield* threads.getThreadShell(request.threadId).pipe(
      Effect.mapError(
        () =>
          new DevelopmentEnvironmentLifecycle.DevelopmentEnvironmentLifecycleError({
            operation: "create",
            reason: "state-unreadable",
          }),
      ),
    );
    if (existing?.developmentEnvironment != null) {
      return existing.developmentEnvironment.xwingEnvironmentId;
    }
  }
  const lifecycle = yield* DevelopmentEnvironmentLifecycle.DevelopmentEnvironmentLifecycle;
  const suffix = (yield* randomUuidV4).replaceAll("-", "").slice(0, 6);
  const name = request.title.replace(/\s+/g, " ").trim().slice(0, 200);
  const created = yield* lifecycle.create({
    projectId: request.projectId,
    name: name === "" ? "T3 thread" : name,
    branch:
      strategy.branch ??
      `${WORKTREE_BRANCH_PREFIX}/${sanitizeBranchFragment(request.title).slice(0, 48)}-${suffix}`,
    base: strategy.baseRef,
  });
  if (created.failure !== null) {
    return yield* new DevelopmentEnvironmentLifecycle.DevelopmentEnvironmentLifecycleError({
      operation: "attach",
      reason: created.failure.reason,
      xwingEnvironmentId: created.xwingEnvironmentId,
    });
  }
  return created.xwingEnvironmentId;
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  request: ThreadLaunchRequest,
) {
  const requested = request.workspaceStrategy;
  const strategy =
    requested.type === "worktree" &&
    (yield* ServerSettings.ServerSettingsService.pipe(Effect.flatMap(readWorktreeProvider))) ===
      "xwing"
      ? {
          type: "xwing_environment" as const,
          xwingEnvironmentId: yield* xwingEnvironmentForWorktreeLaunch(request, requested),
        }
      : requested;
  const input: ThreadLaunch.ThreadLaunchInput =
    strategy.type === "xwing_environment"
      ? {
          ...request,
          ...(yield* DevelopmentEnvironments.DevelopmentEnvironments.pipe(
            Effect.flatMap((environments) =>
              environments.resolveLaunchWorkspace({
                projectId: request.projectId,
                xwingEnvironmentId: strategy.xwingEnvironmentId,
              }),
            ),
          )),
        }
      : { ...request, workspaceStrategy: strategy };
  const launch = launchResolved(input);
  if (input.developmentEnvironment === undefined) return yield* launch;
  const environments = yield* DevelopmentEnvironments.DevelopmentEnvironments;
  return yield* environments.bindLaunch(
    {
      xwingEnvironmentId: input.developmentEnvironment.xwingEnvironmentId,
      threadId: request.threadId,
      commandId: request.commandId,
      title: request.title,
    },
    launch,
  );
});

// The caller's ThreadMessageIntake.launchThread span already covers this.
const launchResolved = Effect.fnUntraced(function* (input: ThreadLaunch.ThreadLaunchInput) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (
          error._tag === "ThreadManagementProviderInstanceDisabledError" ||
          error._tag === "ThreadLaunchWorktreeProviderError"
        ) {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede dispatch; create-thread errors can wrap post-message reads and prove nothing alone.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});
