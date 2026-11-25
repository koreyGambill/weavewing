import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import type {
  ActiveThreadListEntry,
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
  ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import {
  type ChatAttachment,
  type OrchestrationMessageContext,
  CommandId,
  isDelegatedAppThread,
  isListedThreadLineage,
  isOrchestrationV2WorkActive,
  MessageId,
  OrchestrationV2StopWorkflowError,
  type OrchestrationV2StopWorkflowInput,
  OrchestrationV2ForceStopThreadError,
  type OrchestrationV2ForceStopThreadInput,
  type OrchestrationV2ForceStopThreadResult,
  OrchestrationV2SetThreadToolOverridesError,
  type OrchestrationV2SetThreadToolOverridesInput,
  type OrchestrationV2SetThreadToolOverridesResult,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2LinkedSender,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2TurnItem,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInstanceId,
  type ProviderSessionId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  contextRewindRefusalMessage,
  ProviderAdapterContextRewindDeliveryError,
  ProviderAdapterContextRewindRefusal,
  ProviderAdapterContextRewindRefusedError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { contextRewindContinuationCommand } from "./contextRewind.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectedRowEncodedBytes } from "./threadHistoryPaging.ts";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import { projectTurnItemForDetail } from "./WireProjection.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ThreadWorktreeRestore } from "../workspace/restoreMissingWorktree.ts";

export type ThreadManagementSendMode = "auto" | "queue" | "steer" | "restart";

export interface ThreadManagementProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export function withCreationProvenance(
  command: OrchestrationV2Command,
  provenance: ThreadManagementProvenance,
): OrchestrationV2Command {
  switch (command.type) {
    case "thread.create": {
      // Origins, workspace ownership and a folded-in first message come only from the server.
      const {
        linkOrigin: _linkOrigin,
        delegatedFrom: _delegatedFrom,
        initialMessage: _initialMessage,
        developmentEnvironment: _developmentEnvironment,
        ...rest
      } = command;
      return { ...rest, ...provenance };
    }
    case "thread.metadata.update": {
      const { workspaceChange: _workspaceChange, ...rest } = command;
      return rest;
    }
    case "message.dispatch": {
      // Reply admission comes only from the scoped server send path.
      const {
        replyRequested: _replyRequested,
        idleCheckin: _idleCheckin,
        advisoryOnly: _advisoryOnly,
        ...rest
      } = command;
      return { ...rest, ...provenance };
    }
    case "thread.fork":
    case "thread.merge_back":
    case "delegated_task.request":
      return { ...command, ...provenance };
    default:
      return command;
  }
}

function existingThreadIdsForCommand(
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    // Read-state commands only rewrite the thread payload's visited/unread
    // watermark and open stats; they never touch messages, so they do not need the imported
    // v1 transcript hydrated first. Visits fire on every thread-activity bump
    // while a thread is open, so keeping them off the import path matters.
    case "thread.visit":
    case "thread.mark-unread":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "delegated_task.remote.request":
    case "delegated_task.remote.complete":
    case "delegated_task.remote.stop":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    default:
      return [command.threadId];
  }
}

export type ThreadManagementTerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

export interface ThreadManagementSendInput {
  readonly origin: import("@t3tools/contracts").TurnOrigin;
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly replyRequested?: boolean;
  readonly idleCheckin?: boolean;
  readonly advisoryOnly?: boolean;
  readonly linkedSender?: OrchestrationV2LinkedSender;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly modelSelection?: ModelSelection;
  readonly mode: ThreadManagementSendMode;
  /** Start a new provider session; the orchestrator queues it instead of steering. */
  readonly freshContext?: boolean;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadManagementSendResult {
  readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems"
  >;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
}

export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
  /**
   * Also wait until the thread's own delegated work settles: an ended run
   * still owes the thread's answer while a child, a background task or a
   * completion delivery will wake it again, as a delegated task's result does.
   */
  readonly untilDelegatedWorkSettled?: boolean;
}

export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
  /** With `untilDelegatedWorkSettled`, once settled: the run with the thread's final answer. */
  readonly resultRun?: OrchestrationV2Run;
}

export interface ThreadManagementInterruptInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly reason?: string;
}

export type ThreadManagementInterruptResult =
  | {
      readonly type: "interrupt_requested";
      readonly run: OrchestrationV2Run;
      readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
    }
  | { readonly type: "no_active_run" }
  | {
      readonly type: "already_terminal";
      readonly run: OrchestrationV2Run & { readonly status: ThreadManagementTerminalRunStatus };
    };

export class ThreadManagementThreadNotFoundError extends Schema.TaggedError<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadTranscriptTooLargeError extends Schema.TaggedError<ThreadTranscriptTooLargeError>()(
  "ThreadTranscriptTooLargeError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The thread transcript exceeds the file attachment limit.";
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedError<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementNoSteerableRunError extends Schema.TaggedError<ThreadManagementNoSteerableRunError>()(
  "ThreadManagementNoSteerableRunError",
  {
    threadId: ThreadId,
    mode: Schema.Literals(["steer", "restart"]),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no running turn that can be ${this.mode === "steer" ? "steered" : "restarted"}.`;
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedError<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedError<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedError<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    projectId: Schema.optional(ProjectId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.projectId === undefined
      ? "Unable to list threads."
      : `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export class ThreadManagementWorktreeRestoreError extends Schema.TaggedError<ThreadManagementWorktreeRestoreError>()(
  "ThreadManagementWorktreeRestoreError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Couldn't recreate the missing workspace of thread ${this.threadId}, so the message was not sent.${detail}`;
  }
}

export class ThreadManagementProviderInstanceDisabledError extends Schema.TaggedError<ThreadManagementProviderInstanceDisabledError>()(
  "ThreadManagementProviderInstanceDisabledError",
  {
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}

export class ThreadManagementBackgroundWaitError extends Schema.TaggedError<ThreadManagementBackgroundWaitError>()(
  "ThreadManagementBackgroundWaitError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["unsupported", "unavailable", "failed", "unmatched"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "This provider cannot mark background work as awaited.";
      case "unavailable":
        return "This thread has no live provider session.";
      case "failed":
        return "Failed to update the awaited background work.";
      case "unmatched":
        return "None of these IDs is running background work on this thread, so this request registers no wait for them. If the task already finished, read its output now. Otherwise pass the task ID of a background command or Monitor you started. Subagent, Agent tool, and delegate_task IDs don't go here.";
    }
  }
}

const isProviderAdapterContextRewindRefusedError = Schema.is(
  ProviderAdapterContextRewindRefusedError,
);

/** `reason` is the service's own outcome or, for a refusal, the adapter's typed reason. */
export class ThreadManagementContextRewindError extends Schema.TaggedError<ThreadManagementContextRewindError>()(
  "ThreadManagementContextRewindError",
  {
    threadId: ThreadId,
    reason: Schema.Union([
      Schema.Literals(["unsupported", "unavailable", "failed"]),
      ProviderAdapterContextRewindRefusal,
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Context rewind is not available on this thread: its provider cannot rewind, or the setting is off. Nothing was removed.";
      case "unavailable":
        return "This thread has no running turn to rewind. Nothing was removed.";
      case "failed":
        return "The rewind failed. Nothing was removed; carry on with the task.";
      default:
        return contextRewindRefusalMessage(this.reason);
    }
  }
}

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProviderInstanceDisabledError,
  ThreadManagementWorktreeRestoreError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;

type ThreadManagementFailure = ThreadManagementError | Orchestrator.OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly ensureLegacyTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, LegacyV1ThreadImporter.LegacyV1ThreadImportError>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<
    Orchestrator.OrchestratorV2DispatchResult,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadHistoryPage: Orchestrator.OrchestratorV2["Service"]["getThreadHistoryPage"];
  readonly getTimelinePage: Orchestrator.OrchestratorV2["Service"]["getTimelinePage"];
  readonly getMessageCount: Orchestrator.OrchestratorV2["Service"]["getMessageCount"];
  readonly getMessagesById: Orchestrator.OrchestratorV2["Service"]["getMessagesById"];
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2GetTurnItemResult, Orchestrator.OrchestratorV2Error>;
  readonly getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"];
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, Orchestrator.OrchestratorV2Error>;
  readonly getCheckpointContext: Orchestrator.OrchestratorV2["Service"]["getCheckpointContext"];
  readonly getThreadSnapshot: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshot"];
  readonly getThreadTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadTranscript,
    Orchestrator.OrchestratorV2Error | ThreadTranscriptTooLargeError,
    ServerEnvironment.ServerEnvironmentIdentity
  >;
  readonly getThreadSnapshotWindow: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshotWindow"];
  readonly getProjectThreadRecords: <K extends ProjectionRecordField>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<
    ProjectionRecords<K>,
    ThreadManagementProjectionLoadError | ThreadManagementThreadNotFoundError
  >;
  readonly getAgentAwarenessSnapshot: Orchestrator.OrchestratorV2["Service"]["getAgentAwarenessSnapshot"];
  readonly getShellSnapshot: (
    options?: Pick<
      ShellSnapshotOptions,
      "location" | "projectId" | "unsettledOnly" | "worktreePath" | "threadIds"
    >,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>;
  readonly listActiveSubagentThreadIds: Orchestrator.OrchestratorV2["Service"]["listActiveSubagentThreadIds"];
  readonly countThreads: Orchestrator.OrchestratorV2["Service"]["countThreads"];
  readonly listActiveShellIndex: Orchestrator.OrchestratorV2["Service"]["listActiveShellIndex"];
  readonly listOlderSettledThreads: Orchestrator.OrchestratorV2["Service"]["listOlderSettledThreads"];
  readonly readShellSnapshot: (
    options?: Pick<ShellSnapshotOptions, "location" | "familyOf" | "worktreePath" | "threadIds">,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>,
    Orchestrator.OrchestratorV2Error
  >;
  readonly getThreadShell: Orchestrator.OrchestratorV2["Service"]["getThreadShell"];
  readonly listAppOwnedChildThreadIds: Orchestrator.OrchestratorV2["Service"]["listAppOwnedChildThreadIds"];
  readonly getThreadLinkMetadata: Orchestrator.OrchestratorV2["Service"]["getThreadLinkMetadata"];
  readonly getThreadTitles: Orchestrator.OrchestratorV2["Service"]["getThreadTitles"];
  /** Omit `projectId` to list every project's threads. Side chats are never listed. */
  readonly listProjectThreads: (input: {
    readonly projectId?: ProjectId | undefined;
    readonly includeSubagents: boolean;
  }) => Effect.Effect<ReadonlyArray<ActiveThreadListEntry>, ThreadManagementError>;
  readonly sendToThread: (
    input: ThreadManagementSendInput,
  ) => Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure>;
  readonly assertProviderInstanceEnabled: (input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void, ThreadManagementProviderInstanceDisabledError>;
  readonly isProviderInstanceEnabledForProject: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
  /** Receipt replays start no work; skip enablement checks with the same command id so settings cannot reject accepted retries. */
  readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
  readonly waitForThread: (
    input: ThreadManagementWaitInput,
  ) => Effect.Effect<ThreadManagementWaitResult, ThreadManagementError>;
  /** Waits for the agent's run and automatic follow-ups before settling.
   * A new user turn or an unsuccessful ending leaves the thread active. */
  readonly settleAfterRun: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, ThreadManagementFailure>;
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly byOwnAgent: boolean;
  }) => Effect.Effect<
    { readonly sequence: number } | { readonly settlesWhenTurnEnds: true },
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly interruptThread: (
    input: ThreadManagementInterruptInput,
  ) => Effect.Effect<ThreadManagementInterruptResult, ThreadManagementFailure>;
  readonly stopWorkflow: (
    input: OrchestrationV2StopWorkflowInput,
  ) => Effect.Effect<void, OrchestrationV2StopWorkflowError>;
  /**
   * Kills the thread's agent for a provider that no longer responds, then ends
   * its turn as interrupted. Never kills a process other working threads share.
   */
  readonly forceStopThread: (
    input: OrchestrationV2ForceStopThreadInput,
  ) => Effect.Effect<OrchestrationV2ForceStopThreadResult, OrchestrationV2ForceStopThreadError>;
  /**
   * Replaces a Claude thread's tool overrides and reloads its session so the next turn resumes
   * the same conversation with the new tools. Refuses while a turn or background work runs.
   */
  readonly setThreadToolOverrides: (
    input: OrchestrationV2SetThreadToolOverridesInput,
  ) => Effect.Effect<
    OrchestrationV2SetThreadToolOverridesResult,
    OrchestrationV2SetThreadToolOverridesError
  >;
  readonly awaitBackgroundTasks: (input: {
    readonly threadId: ThreadId;
    readonly taskIds: ReadonlyArray<string>;
    readonly awaited: boolean;
  }) => Effect.Effect<
    { readonly matched: ReadonlyArray<string>; readonly unmatched: ReadonlyArray<string> },
    ThreadManagementBackgroundWaitError
  >;
  /**
   * Drops the thread's latest tool calls from its agent's context and queues `summary` as the
   * message that continues the task. The thread keeps every item and shows that message.
   */
  readonly rewindContext: (input: {
    readonly threadId: ThreadId;
    readonly summary: string;
    readonly toolCalls?: number | undefined;
  }) => Effect.Effect<{ readonly removedToolCalls: number }, ThreadManagementContextRewindError>;
  readonly stopDelegatedTasks: (input: {
    readonly remoteDispatch?: Orchestrator.OrchestratorV2["Service"]["dispatch"];
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly reason?: string | undefined;
  }) => Effect.Effect<
    void,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadEventSequence: Orchestrator.OrchestratorV2["Service"]["getThreadEventSequence"];
  readonly recoverDelegatedTask: Orchestrator.OrchestratorV2["Service"]["recoverDelegatedTask"];
  readonly cancelDelegatedTask: Orchestrator.OrchestratorV2["Service"]["cancelDelegatedTask"];
  readonly delegatedTaskResultPending: Orchestrator.OrchestratorV2["Service"]["delegatedTaskResultPending"];
  readonly streamStoredEvents: Orchestrator.OrchestratorV2["Service"]["streamStoredEvents"];
  readonly streamStoredEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"];
  readonly streamDomainEvents: Orchestrator.OrchestratorV2["Service"]["streamDomainEvents"];
  readonly streamDomainEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamDomainEventsFrom"];
  readonly latestDomainEventSequence: Orchestrator.OrchestratorV2["Service"]["latestDomainEventSequence"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("t3/orchestration-v2/ThreadManagementService") {}

export const ACTIVE_RUN_STATUSES = [
  "preparing",
  "starting",
  "running",
  "waiting",
] as const satisfies ReadonlyArray<OrchestrationV2Run["status"]>;

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (ACTIVE_RUN_STATUSES as ReadonlyArray<OrchestrationV2Run["status"]>).includes(run.status);
}

export function isTerminalRunStatus(
  status: OrchestrationV2Run["status"],
): status is ThreadManagementTerminalRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "rolled_back"
  );
}

export function latestRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

function latestRestartContinuation(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

export function latestActiveRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

function latestSteerableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;
const FORCE_STOP_REASON = "Force stopped by user";
const FORCE_STOP_RELEASE_WAIT = "10 seconds";
const isForceStopThreadError = Schema.is(OrchestrationV2ForceStopThreadError);

const make = Effect.gen(function* () {
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const layerScope = yield* Effect.scope;
  const agentScope = yield* AgentScope;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const worktreeRestore = yield* ThreadWorktreeRestore;

  const assertProviderInstanceEnabled: ThreadManagementServiceShape["assertProviderInstanceEnabled"] =
    (input) =>
      receipts.getByCommandId(input.commandId).pipe(
        Effect.orElseSucceed(() => Option.none()),
        Effect.flatMap((receipt) =>
          Option.isSome(receipt)
            ? Effect.void
            : serverSettings.getSettings.pipe(
                Effect.orDie,
                Effect.flatMap((current) =>
                  resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId)
                    ? Effect.void
                    : new ThreadManagementProviderInstanceDisabledError({
                        projectId: input.projectId,
                        instanceId: input.instanceId,
                      }),
                ),
              ),
        ),
      );

  const isProviderInstanceEnabledForProject: ThreadManagementServiceShape["isProviderInstanceEnabledForProject"] =
    (input) =>
      serverSettings.getSettings.pipe(
        Effect.orDie,
        Effect.map((current) =>
          resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId),
        ),
      );

  const hasReceipt: ThreadManagementServiceShape["hasReceipt"] = (commandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map(Option.isSome),
    );

  const ensureLegacyTranscript = Effect.fn(
    "orchestrationV2.threadManagement.ensureLegacyTranscript",
  )(function* (threadId: ThreadId) {
    yield* legacyImporter.ensureTranscript(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Unable to hydrate migrated v1 thread transcript", {
          threadId,
          cause,
        }),
      ),
    );
  });

  const ensureProjectionTranscript = (threadId: ThreadId) =>
    ensureLegacyTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2ServerCommand) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  });

  const getThreadProjection: ThreadManagementServiceShape["getThreadProjection"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadProjection(threadId)),
    );

  const getCheckpointContext: ThreadManagementServiceShape["getCheckpointContext"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getCheckpointContext(threadId)),
    );

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
    );
  // Full-thread exports can otherwise hold every SQLite reader and stall ordinary thread opens.
  const transcriptExportPermits = yield* Semaphore.make(2);
  const getThreadTranscript = Effect.fn("orchestrationV2.threadManagement.getThreadTranscript")(
    function* (threadId: ThreadId) {
      yield* ensureProjectionTranscript(threadId);
      const byteFloor = yield* orchestrator.getTranscriptByteFloor(
        threadId,
        PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      );
      if (byteFloor > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      const { projection } = yield* orchestrator.getThreadSnapshot(threadId);
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const transcript = {
        threadId: projection.thread.id,
        title: projection.thread.title,
        updatedAt: projection.updatedAt,
        items: projection.visibleTurnItems,
      };
      let sizeBytes = Buffer.byteLength(
        threadTranscriptHeader(yield* environment.getEnvironmentId, transcript),
        "utf8",
      );
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      for (const row of transcript.items) {
        sizeBytes += projectedRowEncodedBytes(row) + 1;
        if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          return yield* new ThreadTranscriptTooLargeError({ threadId });
        }
      }
      return transcript;
    },
    transcriptExportPermits.withPermits(1),
  );
  const getThreadSnapshotWindow: ThreadManagementServiceShape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshotWindow(threadId, options)),
    );

  const assertDispatchTargetEnabled = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "thread.metadata.update":
        return command.continuation === undefined
          ? Effect.void
          : orchestrator.getThreadRecords(command.threadId, []).pipe(
              Effect.flatMap((projection) =>
                assertProviderInstanceEnabled({
                  projectId: projection.thread.projectId,
                  commandId: command.commandId,
                  instanceId: projection.thread.modelSelection.instanceId,
                }),
              ),
            );
      case "message.dispatch":
        return orchestrator.getThreadRecords(command.threadId, []).pipe(
          Effect.flatMap((projection) =>
            assertProviderInstanceEnabled({
              projectId: projection.thread.projectId,
              commandId: command.commandId,
              instanceId: (command.modelSelection ?? projection.thread.modelSelection).instanceId,
            }),
          ),
        );
      case "delegated_task.request":
        return orchestrator.getThreadRecords(command.parentThreadId, []).pipe(
          Effect.flatMap((parent) =>
            assertProviderInstanceEnabled({
              projectId: parent.thread.projectId,
              commandId: command.commandId,
              instanceId: command.modelSelection.instanceId,
            }),
          ),
        );
      case "prepared-run.release":
      case "prepared-run.retry":
        return orchestrator
          .getThreadRecords(command.threadId, ["runs"], { runIds: [command.runId] })
          .pipe(
            Effect.flatMap((projection) => {
              const run = projection.runs.find((candidate) => candidate.id === command.runId);
              return run === undefined
                ? Effect.void
                : assertProviderInstanceEnabled({
                    projectId: projection.thread.projectId,
                    commandId: command.commandId,
                    instanceId: run.providerInstanceId,
                  });
            }),
          );
      default:
        return Effect.void;
    }
  };

  const dispatch: ThreadManagementServiceShape["dispatch"] = (command) =>
    ensureCommandTranscripts(command).pipe(
      Effect.andThen(assertDispatchTargetEnabled(command)),
      Effect.andThen(orchestrator.dispatch(command)),
    );

  const getProjectThreadRecords: ThreadManagementServiceShape["getProjectThreadRecords"] = (
    input,
    fields,
    filter,
  ) =>
    ensureProjectionTranscript(input.threadId).pipe(
      Effect.andThen(orchestrator.getThreadRecords(input.threadId, fields, filter)),
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.filterOrFail(
        (projection) =>
          projection.thread.projectId === input.projectId && projection.thread.deletedAt === null,
        (_projection) =>
          new ThreadManagementThreadNotFoundError({
            projectId: input.projectId,
            threadId: input.threadId,
          }),
      ),
    );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator.listActiveThreads(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectThreadsListError({
            projectId: input.projectId,
            cause,
          }),
      ),
      Effect.map((threads) =>
        threads
          .filter((thread) =>
            input.includeSubagents
              ? thread.lineage.sideChat !== true
              : isListedThreadLineage(thread.lineage) && !isDelegatedAppThread(thread),
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
              right.id.localeCompare(left.id),
          ),
      ),
    );

  /** Whether a run, delegated task or background task will still wake the thread. */
  const owesFollowUp = Effect.fn("ThreadManagementService.owesFollowUp")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) {
    const records = yield* getProjectThreadRecords(
      input,
      ["runs", "messages", "subagents", "providerThreads"],
      { messageRoles: ["user"], monitorNotificationsOnly: true },
    );
    if (
      records.runs.some((run) => !isTerminalRunStatus(run.status)) ||
      delegatedTaskProgress(records).childrenPending
    )
      return true;
    return yield* orchestrator.delegatedTaskResultPending(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
    );
  });

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = Effect.fn(
    "ThreadManagementService.sendToThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    if (target.thread.archivedAt !== null && !input.idleCheckin) {
      return yield* new ThreadManagementThreadArchivedError({
        threadId: input.threadId,
      });
    }
    const steerableRun = latestSteerableRun(target);
    // A fresh send never joins a running turn, so it needs none to steer or restart.
    const mode =
      input.freshContext && (input.mode === "steer" || input.mode === "restart")
        ? "queue"
        : input.mode;
    let dispatchMode: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" }
    >["dispatchMode"];
    if (
      mode === "steer" &&
      steerableRun === undefined &&
      !input.advisoryOnly &&
      (yield* owesFollowUp(input))
    ) {
      // Between turns, with work still due to wake the thread, the steer becomes its next turn.
      dispatchMode = { type: "queue_after_active" };
    } else if (mode === "steer" || mode === "restart") {
      if (steerableRun === undefined) {
        return yield* new ThreadManagementNoSteerableRunError({
          threadId: input.threadId,
          mode,
        });
      }
      dispatchMode = {
        type: mode === "steer" ? "steer_active" : "restart_active",
        targetRunId: steerableRun.id,
      };
    } else if (mode === "auto" && steerableRun !== undefined) {
      dispatchMode = { type: "steer_active", targetRunId: steerableRun.id };
    } else {
      dispatchMode = {
        type: mode === "queue" ? "queue_after_active" : "start_immediately",
      };
    }

    // Turn start would fail on its own after the send reported success; a replay keeps its answer.
    // A live steer starts no turn, so it needs no workspace.
    if (dispatchMode.type !== "steer_active") {
      yield* worktreeRestore
        .restore(target.thread)
        .pipe(
          Effect.catch((cause) =>
            hasReceipt(input.commandId).pipe(
              Effect.flatMap((replay) =>
                replay
                  ? Effect.void
                  : Effect.fail(
                      new ThreadManagementWorktreeRestoreError({ threadId: input.threadId, cause }),
                    ),
              ),
            ),
          ),
        );
    }

    const dispatched = yield* dispatch({
      type: "message.dispatch",
      origin: input.origin,
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      ...(input.replyRequested ? { replyRequested: true } : {}),
      ...(input.idleCheckin ? { idleCheckin: true } : {}),
      ...(input.advisoryOnly ? { advisoryOnly: true } : {}),
      ...(input.linkedSender === undefined ? {} : { linkedSender: input.linkedSender }),
      text: input.text,
      attachments: input.attachments,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      ...(input.freshContext ? { freshContext: true } : {}),
      dispatchMode,
      ...(mode === "auto" ? { deliveryIntent: "auto" } : {}),
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    const projection = yield* getProjectThreadRecords(input, ["runs", "messages", "turnItems"], {
      messageIds: [input.messageId],
      turnItemTypes: ["user_message"],
    });
    const message = projection.messages.find((candidate) => candidate.id === input.messageId);
    const run =
      message?.runId === null || message?.runId === undefined
        ? undefined
        : projection.runs.find((candidate) => candidate.id === message.runId);
    const turnItem =
      projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" && candidate.messageId === input.messageId,
      ) ?? null;
    if (
      message === undefined ||
      run === undefined ||
      (turnItem === null && run.status !== "queued")
    ) {
      return yield* new ThreadManagementDurableRunProjectionError({
        threadId: input.threadId,
        messageId: input.messageId,
      });
    }
    // A provider without interrupt-and-restart stops the turn and runs the
    // restart as the next turn. Read from this command's own events, so a replay agrees.
    const restartedAsNextTurn =
      mode === "restart" &&
      dispatched.storedEvents.some(
        ({ event }) =>
          event.type === "turn-item.updated" &&
          event.payload.type === "run_interrupt_request" &&
          event.payload.runId !== run.id,
      );
    const delivery: ThreadManagementSendResult["delivery"] = restartedAsNextTurn
      ? "restarted"
      : turnItem === null || turnItem.inputIntent === "queued_turn"
        ? "queued"
        : turnItem.inputIntent === "turn_start"
          ? "started"
          : mode === "restart"
            ? "restarted"
            : "steered";
    return { dispatch: dispatched, projection, message, run, turnItem, delivery };
  });

  const waitForThread: ThreadManagementServiceShape["waitForThread"] = Effect.fn(
    "ThreadManagementService.waitForThread",
  )(function* (input) {
    const loadError = (cause: unknown) =>
      new ThreadManagementProjectionLoadError({
        projectId: input.projectId,
        threadId: input.threadId,
        cause,
      });
    const untilDelegatedWorkSettled = input.untilDelegatedWorkSettled === true;
    // Replay covers commits between the watermark and acquiring the live subscriptions.
    const afterSequence = yield* orchestrator
      .getThreadEventSequence(input.threadId)
      .pipe(Effect.mapError(loadError));
    // One stream preserves creation/terminal order across record types.
    const events = yield* orchestrator
      .streamStoredEventsFrom({ threadId: input.threadId, afterSequence })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" ||
            event.type === "thread.deleted" ||
            (untilDelegatedWorkSettled &&
              (event.type === "run.created" ||
                event.type === "message.updated" ||
                event.type === "subagent.updated" ||
                event.type === "provider-thread.updated")),
        ),
        Stream.mapError(loadError),
        Stream.toQueue({ capacity: "unbounded" }),
      );
    const read = () =>
      getProjectThreadRecords(
        input,
        untilDelegatedWorkSettled ? ["runs", "messages", "subagents", "providerThreads"] : ["runs"],
        { messageRoles: ["user"], monitorNotificationsOnly: true },
      );
    const target = yield* read();
    const selectedRun =
      input.runId === undefined
        ? latestRun(target)
        : target.runs.find((run) => run.id === input.runId);
    if (input.runId !== undefined && selectedRun === undefined)
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    if (selectedRun === undefined) return { threadId: input.threadId, run: null, timedOut: false };

    const pending = new Set<string>();
    const monitorRuns = new Set<RunId | null>();
    let awaitedRunId = selectedRun.id;
    const continuationWakes = yield* Queue.unbounded<RunId>();
    const watchingContinuations = new Set<RunId>();
    const track = (key: string, active: boolean) => {
      if (active) pending.add(key);
      else pending.delete(key);
    };
    const trackRun = (run: OrchestrationV2Run) =>
      track(
        `run:${run.id}`,
        !isTerminalRunStatus(run.status) &&
          (run.id === awaitedRunId ||
            (!monitorRuns.has(run.id) && !(run.status === "queued" && run.queueHeld === true))),
      );
    const trackTask = (task: OrchestrationV2ThreadProjection["subagents"][number]) => {
      track(`task:${task.id}`, isOrchestrationV2WorkActive(task.status));
      track(
        `delivery:${task.id}`,
        task.status !== "idle" &&
          (task.completionDelivery?.state === "pending" ||
            task.completionDelivery?.state === "claimed"),
      );
    };
    const trackBackground = (thread: OrchestrationV2ThreadProjection["providerThreads"][number]) =>
      track(
        `background:${thread.id}`,
        backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [], { awaitUnmarked: true }),
      );
    // The evaluation owns the span; the wait scope owns its continuation fibers.
    const watchContinuation = Effect.fnUntraced(function* (run: OrchestrationV2Run) {
      pending.add(`continuation:${run.id}`);
      if (watchingContinuations.has(run.id)) return;
      watchingContinuations.add(run.id);
      yield* orchestrator
        .awaitRestartContinuation(run)
        .pipe(Effect.andThen(Queue.offer(continuationWakes, run.id)), Effect.forkScoped);
    });
    const evaluate = Effect.fn("orchestrationV2.threadManagement.evaluate")(function* (
      records: typeof target,
    ) {
      pending.clear();
      const original = records.runs.find((run) => run.id === selectedRun.id);
      if (original === undefined)
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: selectedRun.id,
        });
      const run = latestRestartContinuation(records.runs, original);
      awaitedRunId = run.id;
      const continuationPending =
        isTerminalRunStatus(run.status) && (yield* orchestrator.restartContinuationPending(run));
      if (continuationPending) yield* watchContinuation(run);
      if (untilDelegatedWorkSettled) {
        monitorRuns.clear();
        for (const message of records.messages)
          if (message.notification?.source.kind === "monitor") monitorRuns.add(message.runId);
        for (const candidate of records.runs) trackRun(candidate);
        for (const task of records.subagents) trackTask(task);
        for (const provider of records.providerThreads) trackBackground(provider);
      } else trackRun(run);
      let resultRun: OrchestrationV2Run | undefined;
      let settled = isTerminalRunStatus(run.status) && !continuationPending;
      if (settled && untilDelegatedWorkSettled) {
        const progress = delegatedTaskProgress(records);
        if (
          progress.resultRun === undefined &&
          records.runs.every((candidate) => isTerminalRunStatus(candidate.status))
        )
          resultRun = latestRun(records);
        else if (progress.state === "result_available") {
          const resultPending = yield* orchestrator
            .delegatedTaskResultPending(input.threadId)
            .pipe(Effect.mapError(loadError));
          if (!resultPending) resultRun = progress.resultRun;
          else if (progress.resultRun !== undefined) {
            for (const candidate of records.runs) {
              if (
                (candidate.id === progress.resultRun.id ||
                  runRanAfter(candidate, progress.resultRun)) &&
                (yield* orchestrator.restartContinuationPending(candidate))
              )
                yield* watchContinuation(candidate);
            }
            // A continuation may settle between checking it and installing its waiter.
            if (pending.size === 0) yield* watchContinuation(progress.resultRun);
          }
        }
        settled = resultRun !== undefined;
      }
      return { run, settled, resultRun };
    });
    const settledResult = (current: Effect.Success<ReturnType<typeof evaluate>>) => ({
      threadId: input.threadId,
      run: current.run,
      timedOut: !current.settled,
      ...(current.resultRun === undefined ? {} : { resultRun: current.resultRun }),
    });
    const initial = yield* evaluate(target);
    if (initial.settled) return settledResult(initial);

    const wait = Stream.merge(
      Stream.fromQueue(events).pipe(Stream.map((stored) => ({ kind: "event" as const, stored }))),
      Stream.fromQueue(continuationWakes).pipe(
        Stream.map((runId) => ({ kind: "continuation" as const, runId })),
      ),
    ).pipe(
      Stream.mapEffect((update) => {
        const shouldRead = (() => {
          if (update.kind === "continuation") {
            watchingContinuations.delete(update.runId);
            return pending.delete(`continuation:${update.runId}`) && pending.size === 0;
          }
          const { event } = update.stored;
          if (!untilDelegatedWorkSettled)
            return (
              event.type === "thread.deleted" ||
              (event.type === "run.updated" &&
                (event.payload.id === selectedRun.id ||
                  event.payload.restartContinuationOfRunId !== undefined))
            );
          const before = pending.size;
          switch (event.type) {
            case "thread.deleted":
              return true;
            case "run.created":
            case "run.updated":
              trackRun(event.payload);
              if (event.payload.restartContinuationOfRunId !== undefined)
                pending.delete(`continuation:${event.payload.restartContinuationOfRunId}`);
              break;
            case "message.updated":
              if (event.payload.notification?.source.kind !== "monitor") return false;
              monitorRuns.add(event.payload.runId);
              if (event.payload.runId !== awaitedRunId)
                pending.delete(`run:${event.payload.runId}`);
              break;
            case "subagent.updated":
              trackTask(event.payload);
              break;
            case "provider-thread.updated":
              trackBackground(event.payload);
              break;
            default:
              return false;
          }
          // Only removal of the last member needs another authoritative snapshot.
          return pending.size === 0 && before > 0;
        })();
        return shouldRead ? read().pipe(Effect.flatMap(evaluate)) : Effect.undefined;
      }),
      Stream.filter((current): current is NonNullable<typeof current> => current?.settled === true),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
    );
    const waited = Option.flatten(yield* wait);
    if (Option.isSome(waited)) return settledResult(waited.value);
    return settledResult(yield* evaluate(yield* read()));
  }, Effect.scoped);

  const settleAfterRun: ThreadManagementServiceShape["settleAfterRun"] = Effect.fn(
    "orchestrationV2.threadManagement.settleAfterRun",
  )(function* (input) {
    const requestedAt = yield* DateTime.now;
    const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
    if (run?.status !== "completed") return;
    const afterSequence = yield* orchestrator.getThreadEventSequence(input.threadId);
    const trySettle = Effect.gen(function* () {
      const sequence = yield* orchestrator.getThreadEventSequence(input.threadId);
      const records = yield* getProjectThreadRecords(input, ["runs"]);
      // Settling ends every watch; one the agent started after asking to settle must outlive it.
      if (
        threadPullRequestsOf(records.thread).some(
          (link) =>
            link.watch !== undefined &&
            !DateTime.isLessThan(DateTime.makeUnsafe(link.watch.startedAt), requestedAt),
        )
      )
        return true;
      const later = records.runs.filter((candidate) => candidate.ordinal > run.ordinal);
      const cancelledMessageIds = later
        .filter((candidate) => candidate.status === "cancelled")
        .map((candidate) => candidate.userMessageId);
      // Send now cancels a queued run and moves its message into the running turn.
      const steeredMessageIds =
        cancelledMessageIds.length === 0
          ? new Set()
          : new Set(
              (yield* getProjectThreadRecords(input, ["messages"], {
                messageIds: cancelledMessageIds,
              })).messages
                .filter((message) => message.runId === run.id)
                .map((message) => message.id),
            );
      const following = later.filter(
        (candidate) =>
          candidate.status !== "cancelled" || !steeredMessageIds.has(candidate.userMessageId),
      );
      if (following.length > 0) {
        const { messages } = yield* getProjectThreadRecords(input, ["messages"], {
          messageRunIds: following.map((candidate) => candidate.id),
          messageRoles: ["user"],
        });
        const automaticMessageIds = new Set(
          messages
            .filter(
              (message) =>
                message.role === "user" &&
                (message.notification !== undefined || message.delegatedCompletion !== undefined),
            )
            .map((message) => message.id),
        );
        if (
          messages.some((message) => !automaticMessageIds.has(message.id)) ||
          following.some((candidate) => !automaticMessageIds.has(candidate.userMessageId))
        ) {
          return true;
        }
        if (
          following.some(
            (candidate) => candidate.status !== "queued" && !isTerminalRunStatus(candidate.status),
          )
        )
          return false;
        if (
          following.some(
            (candidate) => candidate.status !== "queued" && candidate.status !== "completed",
          )
        )
          return true;
      }
      const latest = latestRun(records);
      if (latest === undefined) return true;
      return yield* dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`server:settle-after-run:${input.runId}:${sequence}`),
        threadId: input.threadId,
        expectedLatestRunId: latest.id,
      }).pipe(
        Effect.as(true),
        // A notification can start between the projection read and the guarded dispatch.
        Effect.catchTags({
          OrchestratorDispatchError: () => Effect.succeed(false),
          OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed(false),
        }),
      );
    });
    yield* Stream.fromEffect(trySettle).pipe(
      Stream.concat(
        orchestrator
          .streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType: "run.updated",
          })
          .pipe(Stream.mapEffect(() => trySettle)),
      ),
      Stream.filter((done) => done),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(SETTLE_AFTER_RUN_WAIT_MS)),
    );
  });

  const settleThread: ThreadManagementServiceShape["settleThread"] = Effect.fn(
    "orchestrationV2.threadManagement.settleThread",
  )(function* (input) {
    const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
    if (shell != null && shell.activeRunId !== null) {
      yield* settleAfterRun({
        projectId: shell.projectId,
        threadId: shell.id,
        runId: shell.activeRunId,
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
      return { settlesWhenTurnEnds: true } as const;
    }
    const result = yield* dispatch({
      type: "thread.settle",
      commandId: input.commandId,
      threadId: input.threadId,
    });
    return { sequence: result.sequence };
  });

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = Effect.fn(
    "ThreadManagementService.interruptThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    const explicitRun =
      input.runId === undefined
        ? undefined
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && explicitRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
      return {
        type: "already_terminal",
        run: explicitRun as OrchestrationV2Run & {
          readonly status: ThreadManagementTerminalRunStatus;
        },
      } as const;
    }
    const interruptibleRun = latestActiveRun(target);
    if (interruptibleRun === undefined) {
      if (input.runId === undefined) {
        return { type: "no_active_run" } as const;
      }
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    const dispatch = yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: interruptibleRun.id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return { type: "interrupt_requested", run: interruptibleRun, dispatch } as const;
  });

  const setThreadToolOverrides: ThreadManagementServiceShape["setThreadToolOverrides"] = Effect.fn(
    "ThreadManagementService.setThreadToolOverrides",
  )(
    function* (input) {
      const result = yield* orchestrator.dispatch({
        type: "thread.tool-overrides.set",
        commandId: CommandId.make(
          `server:tool-overrides:${input.threadId}:${yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())}`,
        ),
        threadId: input.threadId,
        toolOverrides: input.toolOverrides,
      });
      return {
        outcome: result.storedEvents.some(
          (stored) => stored.event.type === "provider-session.detached",
        )
          ? ("restart-scheduled" as const)
          : ("stored" as const),
      };
    },
    Effect.catchTags({
      OrchestratorThreadToolOverridesRejectedError: (cause) =>
        Effect.fail(
          new OrchestrationV2SetThreadToolOverridesError({
            threadId: cause.threadId,
            reason: cause.reason,
          }),
        ),
    }),
    (effect, input) =>
      Effect.mapError(effect, (cause) =>
        cause._tag === "OrchestrationV2SetThreadToolOverridesError"
          ? cause
          : new OrchestrationV2SetThreadToolOverridesError({
              threadId: input.threadId,
              reason: "failed",
              cause,
            }),
      ),
  );

  const forceStopThread: ThreadManagementServiceShape["forceStopThread"] = Effect.fn(
    "ThreadManagementService.forceStopThread",
  )(
    function* (input) {
      // Under the thread lock no new run can be created between the check and the kill. The
      // settlement below dispatches, which takes that lock itself, so it runs after release.
      const { records, target, killed } = yield* threadDispatch.withLock(
        input.threadId,
        Effect.gen(function* () {
          const records = yield* orchestrator.getThreadRecords(input.threadId, [
            "runs",
            "providerThreads",
            "providerTurns",
          ]);
          // The run Force stop acts on: the active one, else the latest that started. Queued
          // follow-ups never ran, so they neither count as targets nor supersede the request.
          const target =
            latestActiveRun(records) ??
            records.runs
              .filter((run) => run.status !== "queued")
              .reduce<OrchestrationV2Run | undefined>(
                (current, run) =>
                  current === undefined || run.ordinal > current.ordinal ? run : current,
                undefined,
              );
          if (input.runId !== undefined && input.runId !== target?.id) {
            return yield* new OrchestrationV2ForceStopThreadError({
              threadId: input.threadId,
              reason: "superseded",
            });
          }
          // Shared scopes are never tracked per thread, so this only kills the thread's own agent.
          const killed = yield* agentScope.kill(input.threadId);
          return { records, target, killed };
        }),
      );
      const sessionIds = new Set(
        records.providerThreads.flatMap((providerThread) =>
          providerThread.appThreadId === input.threadId && providerThread.providerSessionId !== null
            ? [providerThread.providerSessionId]
            : [],
        ),
      );
      // A run that already ended may still hold background work; settling it is a no-op otherwise.
      const run = target;
      if (run !== undefined) {
        const active = isActiveRun(run);
        const providerTurn = records.providerTurns.findLast(
          (turn) =>
            turn.runAttemptId === run.activeAttemptId && (!active || turn.status === "running"),
        );
        const commandId = CommandId.make(
          `server:force-stop:${run.id}:${yield* Clock.currentTimeMillis}`,
        );
        yield* providerTurn === undefined && !active
          ? Effect.void
          : providerTurn === undefined
            ? orchestrator.dispatch({
                type: "run.interrupt",
                commandId,
                threadId: input.threadId,
                runId: run.id,
                reason: FORCE_STOP_REASON,
              })
            : orchestrator.dispatch({
                type: "thread.background-work.settle",
                commandId,
                threadId: input.threadId,
                providerThreadId: providerTurn.providerThreadId,
                providerTurnId: providerTurn.id,
                reason: FORCE_STOP_REASON,
              });
      }
      const ownProviderThreadIds = records.providerThreads.flatMap((providerThread) =>
        providerThread.appThreadId === input.threadId ? [providerThread.id] : [],
      );
      // Settling the target can promote a queued follow-up onto the same session; that run is
      // not Force stop's to end. Only a newer run bound to a provider thread on this session
      // counts. An unreadable thread counts as one, so its sessions are kept.
      const throughRunOrdinal = target?.ordinal ?? 0;
      const laterRunActive = (providerSessionId: ProviderSessionId) =>
        orchestrator.getThreadRecords(input.threadId, ["runs", "providerThreads"]).pipe(
          Effect.map(({ runs, providerThreads }) => {
            const onSession = new Set(
              providerThreads.flatMap((providerThread) =>
                providerThread.providerSessionId === providerSessionId ? [providerThread.id] : [],
              ),
            );
            return runs.some(
              (run) =>
                run.ordinal > throughRunOrdinal &&
                isActiveRun(run) &&
                run.providerThreadId !== null &&
                onSession.has(run.providerThreadId),
            );
          }),
          Effect.orElseSucceed(() => true),
        );
      const detach = (providerSessionId: ProviderSessionId) =>
        sessions
          .detach({ providerSessionId, threadId: input.threadId, detail: FORCE_STOP_REASON })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.force-stop-detach-failed", {
                threadId: input.threadId,
                cause,
              }),
            ),
            Effect.forkIn(layerScope),
          );
      let shared = false;
      const sharedWith = new Set<ThreadId>();
      const releases: Array<{
        readonly providerSessionId: ProviderSessionId;
        readonly fiber: Fiber.Fiber<boolean, ProviderSessionManager.ProviderSessionManagerV2Error>;
      }> = [];
      for (const providerSessionId of sessionIds) {
        if (!(yield* sessions.isLive(providerSessionId))) continue;
        // Decided just before teardown, so the reply matches what happens to the process.
        const others = yield* sessions.otherWorkingThreads({
          providerSessionId,
          threadId: input.threadId,
        });
        for (const threadId of others) sharedWith.add(threadId);
        if (others.length > 0) {
          shared = true;
          yield* detach(providerSessionId);
          continue;
        }
        // The session manager re-checks atomically with turn starts and keeps a session a
        // sibling began using in the meantime.
        const fiber = yield* sessions
          .releaseUnlessBusy({
            providerSessionId,
            ownProviderThreadIds,
            throughRunOrdinal,
            // A promoted follow-up may not have marked its turn busy yet.
            keepIf: laterRunActive(providerSessionId),
            reason: "manual_shutdown",
            detail: FORCE_STOP_REASON,
          })
          .pipe(Effect.forkIn(layerScope));
        releases.push({ providerSessionId, fiber });
      }
      // Teardown waits on the provider's own exit paths; past this bound it keeps going on its own.
      let releasing = false;
      for (const release of releases) {
        const released = yield* Fiber.join(release.fiber).pipe(
          Effect.timeoutOption(FORCE_STOP_RELEASE_WAIT),
        );
        if (Option.isNone(released)) {
          releasing = true;
        } else if (!released.value && !(yield* laterRunActive(release.providerSessionId))) {
          shared = true;
          yield* detach(release.providerSessionId);
        }
      }
      return {
        outcome: killed ? "killed" : shared ? "shared" : releasing ? "releasing" : "released",
        sharedWithThreadIds: [...sharedWith],
      } as const;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isForceStopThreadError(cause)
            ? cause
            : new OrchestrationV2ForceStopThreadError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  const stopWorkflow: ThreadManagementServiceShape["stopWorkflow"] = Effect.fn(
    "ThreadManagementService.stopWorkflow",
  )(
    function* (input) {
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["subagents", "runs", "providerThreads"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (records.thread.deletedAt !== null) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      // Check mode limits under the lock so users cannot raise modes between validation and Stop.
      const limit = yield* DispatchModeLimit;
      const exceeded =
        limit === undefined ? undefined : exceededDispatchModeLimit(limit, records.thread);
      if (limit !== undefined && exceeded !== undefined) {
        if (limit.refused !== undefined) {
          yield* Ref.set(limit.refused, {
            threadId: input.threadId,
            runtimeMode: records.thread.runtimeMode,
            interactionMode: records.thread.interactionMode,
            mode: exceeded,
          });
        }
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const task = records.subagents.find((candidate) => candidate.id === input.subagentId);
      if (
        task === undefined ||
        task.threadId !== input.threadId ||
        task.workflow === undefined ||
        task.status !== "running"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" });
      }
      if (task.origin !== "provider_native" || task.driver !== "claudeAgent") {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      const providerThreadId =
        task.providerThreadId ??
        records.runs.find((run) => run.id === task.runId)?.providerThreadId;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.id === providerThreadId &&
          candidate.appThreadId === input.threadId &&
          candidate.providerInstanceId === task.providerInstanceId &&
          candidate.driver === task.driver,
      );
      const taskId = task.nativeTaskRef?.nativeId;
      if (providerThread?.providerSessionId == null || taskId == null || taskId.length === 0) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (Option.isNone(runtime)) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      if (runtime.value.stopTask === undefined) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      // Bounded so a provider that never answers cannot hold the thread lock.
      yield* runtime.value.stopTask({ providerThread, taskId }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopWorkflowError({
              ...input,
              reason: "stop-failed",
              cause,
            }),
        ),
      );
    },
    (effect, input) => effect.pipe((effect) => threadDispatch.withLock(input.threadId, effect)),
  );

  const awaitBackgroundTasks: ThreadManagementServiceShape["awaitBackgroundTasks"] = Effect.fn(
    "ThreadManagementService.awaitBackgroundTasks",
  )(function* (input) {
    const unavailable = (cause?: unknown) =>
      new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unavailable",
        ...(cause === undefined ? {} : { cause }),
      });
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError(unavailable));
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.id === records.thread.activeProviderThreadId &&
        candidate.appThreadId === input.threadId,
    );
    if (records.thread.deletedAt !== null || providerThread?.providerSessionId == null) {
      return yield* unavailable();
    }
    const runtime = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(runtime)) {
      return yield* unavailable();
    }
    if (runtime.value.awaitBackgroundTasks === undefined) {
      return yield* new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unsupported",
      });
    }
    const { matched } = yield* runtime.value
      .awaitBackgroundTasks({ providerThread, taskIds: input.taskIds, awaited: input.awaited })
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new ThreadManagementBackgroundWaitError({
              threadId: input.threadId,
              reason: "failed",
              cause,
            }),
        ),
      );
    if (input.awaited && matched.length === 0) {
      return yield* new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unmatched",
      });
    }
    const matchedIds = new Set(matched);
    return { matched, unmatched: input.taskIds.filter((taskId) => !matchedIds.has(taskId)) };
  });

  const rewindContext: ThreadManagementServiceShape["rewindContext"] = Effect.fn(
    "ThreadManagementService.rewindContext",
  )(function* (input) {
    const fail = (reason: ThreadManagementContextRewindError["reason"], cause?: unknown) =>
      new ThreadManagementContextRewindError({
        threadId: input.threadId,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail("unavailable", cause)));
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.id === records.thread.activeProviderThreadId &&
        candidate.appThreadId === input.threadId,
    );
    if (records.thread.deletedAt !== null || providerThread?.providerSessionId == null) {
      return yield* fail("unavailable");
    }
    const runtime = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.mapError((cause) => fail("unavailable", cause)));
    if (Option.isNone(runtime)) return yield* fail("unavailable");
    if (runtime.value.rewindContext === undefined) return yield* fail("unsupported");
    return yield* runtime.value
      .rewindContext({
        providerThread,
        ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
        deliver: ({ removedToolCalls, continuationMessageId }) =>
          dispatch(
            contextRewindContinuationCommand({
              threadId: input.threadId,
              messageId: continuationMessageId,
              removedToolCalls,
              summary: input.summary,
            }),
          ).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new ProviderAdapterContextRewindDeliveryError({ cause })),
          ),
      })
      .pipe(
        Effect.mapError((cause) =>
          isProviderAdapterContextRewindRefusedError(cause)
            ? fail(cause.reason, cause)
            : fail("failed", cause),
        ),
      );
  });

  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = Effect.fn(
    "ThreadManagementService.stopDelegatedTasks",
  )(function* (input) {
    const { subagents } = yield* orchestrator.getThreadRecords(input.threadId, ["subagents"]);
    const failures: Array<
      Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
    > = [];
    const stoppedChildThreadIds = new Set<ThreadId>();
    for (const task of subagents) {
      if (task.origin !== "app_owned") continue;
      if (task.childThreadId === null) {
        // A task in a linked environment ends here; its follower then stops it there.
        // One with its result keeps it, but its thread there may run follow-up work.
        if (task.remoteChild === undefined) continue;
        const commandId = CommandId.make(`${input.commandId}:stop:${task.id}`);
        yield* (input.remoteDispatch ?? dispatch)(
          task.result === null
            ? {
                type: "delegated_task.remote.complete",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
                status: "interrupted",
                result:
                  input.reason === undefined
                    ? "Stopped with its parent."
                    : `Stopped with its parent: ${input.reason}`,
              }
            : {
                type: "delegated_task.remote.stop",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
              },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Unable to stop a delegated task", {
              parentThreadId: input.threadId,
              taskId: task.id,
              error,
            }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
          ),
        );
        continue;
      }
      const threadId = task.childThreadId;
      // Follow-up tasks reuse a child thread; walk its subtree only once.
      if (stoppedChildThreadIds.has(threadId)) continue;
      stoppedChildThreadIds.add(threadId);
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
        threadId,
        stopDelegatedTasks: false,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }).pipe(
        Effect.andThen(
          stopDelegatedTasks({ threadId, commandId: input.commandId, reason: input.reason }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Unable to stop a delegated task", {
            parentThreadId: input.threadId,
            threadId,
            error,
          }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
        ),
      );
    }
    if (failures[0] !== undefined) return yield* failures[0];
  });

  return ThreadManagementService.of({
    ensureLegacyTranscript,
    searchThreadStream: (input) =>
      Stream.unwrap(
        ensureProjectionTranscript(input.threadId).pipe(
          Effect.as(orchestrator.searchThreadStream(input)),
        ),
      ),
    searchThread: Effect.fn("ThreadManagementService.searchThread")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.searchThread(input)),
      );
    }),
    dispatch,
    getThreadHistoryPage: Effect.fn("ThreadManagementService.getThreadHistoryPage")(
      function (threadId, cursor, throughEntryId, conversationOnly, workMode) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(
            orchestrator.getThreadHistoryPage(
              threadId,
              cursor,
              throughEntryId,
              conversationOnly,
              workMode,
            ),
          ),
        );
      },
    ),
    getTimelinePage: Effect.fn("ThreadManagementService.getTimelinePage")(
      function (threadId, options) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getTimelinePage(threadId, options)),
        );
      },
    ),
    getMessageCount: Effect.fn("ThreadManagementService.getMessageCount")(function (threadId) {
      return ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getMessageCount(threadId)),
      );
    }),
    getMessagesById: Effect.fn("ThreadManagementService.getMessagesById")(
      function (threadId, messageIds) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getMessagesById(threadId, messageIds)),
        );
      },
    ),
    getTurnItem: Effect.fn("ThreadManagementService.getTurnItem")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getTurnItem(input)),
        Effect.map((item) => ({ item: item === null ? null : projectTurnItemForDetail(item) })),
      );
    }),
    getThreadRecords: Effect.fn("ThreadManagementService.getThreadRecords")(
      function (threadId, fields, filter) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
        );
      },
    ),
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    getProjectThreadRecords,
    getAgentAwarenessSnapshot: orchestrator.getAgentAwarenessSnapshot,
    getShellSnapshot: orchestrator.getShellSnapshot,
    listActiveSubagentThreadIds: orchestrator.listActiveSubagentThreadIds,
    countThreads: orchestrator.countThreads,
    listActiveShellIndex: orchestrator.listActiveShellIndex,
    listOlderSettledThreads: orchestrator.listOlderSettledThreads,
    readShellSnapshot: orchestrator.readShellSnapshot,
    getThreadShell: orchestrator.getThreadShell,
    listAppOwnedChildThreadIds: Effect.fn("ThreadManagementService.listAppOwnedChildThreadIds")(
      function (threadId) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.listAppOwnedChildThreadIds(threadId)),
        );
      },
    ),
    getThreadTitles: orchestrator.getThreadTitles,
    getThreadLinkMetadata: orchestrator.getThreadLinkMetadata,
    listProjectThreads,
    sendToThread,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    waitForThread,
    settleAfterRun,
    settleThread,
    interruptThread,
    stopDelegatedTasks,
    stopWorkflow,
    forceStopThread,
    setThreadToolOverrides,
    awaitBackgroundTasks,
    rewindContext,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    recoverDelegatedTask: orchestrator.recoverDelegatedTask,
    cancelDelegatedTask: orchestrator.cancelDelegatedTask,
    delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    streamDomainEvents: orchestrator.streamDomainEvents,
    streamDomainEventsFrom: orchestrator.streamDomainEventsFrom,
    latestDomainEventSequence: orchestrator.latestDomainEventSequence,
  });
});

const layerThreadWorktreeRestoreNoop = Layer.succeed(ThreadWorktreeRestore, {
  restore: Effect.fn("ThreadWorktreeRestore.restore")(function () {
    return Effect.void;
  }),
});

const layerLegacyV1ThreadImporterNoop = Layer.succeed(
  LegacyV1ThreadImporter.LegacyV1ThreadImporter,
  LegacyV1ThreadImporter.LegacyV1ThreadImporter.of({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    ensureTranscript: Effect.fn("LegacyV1ThreadImporter.ensureTranscript")(function () {
      return Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 });
    }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
);

export const layer: Layer.Layer<
  ThreadManagementService,
  never,
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(
  Layer.provide(layerLegacyV1ThreadImporterNoop),
  Layer.provide(layerThreadWorktreeRestoreNoop),
  Layer.provide(ThreadCommandExecutor.layer),
);

export const layerWithLegacyImporter: Layer.Layer<
  ThreadManagementService,
  never,
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | ThreadWorktreeRestore
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(Layer.provide(ThreadCommandExecutor.layer));
