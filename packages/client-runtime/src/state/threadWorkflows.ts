import {
  type ChatAttachment,
  isCompactionCommandMessage,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import type { ThreadStructure, ThreadStructureVisibleTurnItem } from "./models.ts";

type Projection = ThreadStructure;
type Run = Projection["runs"][number];
type Message = Projection["messages"][number];
type ProviderSession = Projection["providerSessions"][number];

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running", "waiting"]);
const MERGE_BACK_RUN_STATUSES = new Set<Run["status"]>(["waiting", "completed"]);
const FORKABLE_RUN_STATUSES = new Set<Run["status"]>([
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

export interface QueuedThreadRun {
  readonly run: Run;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly messageId: Message["id"];
  readonly context?: Message["context"];
  /** Carries the attribution a sent message shows: automation, agent sender, or guest. */
  readonly message?: Message;
  /** Delivers a Bring back when it starts, so it cannot steer into the current turn. */
  readonly bringsBack: boolean;
}

export interface ThreadQueueWorkflowState {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly isHeld: boolean;
  readonly canPromoteToSteer: boolean;
  /** The active run is a compaction, so promoting a queued message stops it instead of steering. */
  readonly promoteSkipsCompaction: boolean;
  readonly canSendNow: boolean;
}

export function resolveActiveThreadRun(projection: Pick<Projection, "runs">): Run | null {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}

/**
 * A successfully finished provider turn remains in `waiting` while its
 * checkpoint is captured. Keep that newest turn available for merge-back
 * instead of falling through to an older fully checkpointed run.
 */
export function resolveLatestMergeBackRun(projection: Pick<Projection, "runs">): Run | null {
  const latestProviderFinishedRun = projection.runs.reduce<Run | null>(
    (latest, run) =>
      MERGE_BACK_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (latestProviderFinishedRun === null) return null;

  const hasNewerActiveRun = projection.runs.some(
    (run) =>
      run.ordinal > latestProviderFinishedRun.ordinal &&
      MERGE_BACK_BLOCKING_RUN_STATUSES.has(run.status),
  );
  return hasNewerActiveRun ? null : latestProviderFinishedRun;
}

type ContextTransfer = Projection["contextTransfers"][number];

export type BringBackStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "skipped"
  | "failed"
  | "rolled_back";

export interface BringBackRecord {
  readonly transferId: ContextTransfer["id"];
  readonly status: BringBackStatus;
  readonly scope: "additional" | "all";
  /** The side chat's newest turn the request covers, fixed when it was requested. */
  readonly throughRunId: Run["id"] | null;
  readonly throughOrdinal: number | null;
  readonly parentRunId: Run["id"] | null;
  readonly parentMessageId: Message["id"] | null;
  readonly requestedAt: ContextTransfer["createdAt"];
  readonly deliveredAt: ContextTransfer["consumedAt"];
  readonly error: string | null;
}

export interface BringBackState {
  /** Oldest first. */
  readonly records: ReadonlyArray<BringBackRecord>;
  /** The newest side chat turn the parent's surviving conversation holds; 0 when none. */
  readonly includedThroughOrdinal: number;
  /** Like `includedThroughOrdinal`, also counting requests still queued. */
  readonly requestedThroughOrdinal: number;
  /** A finished side chat turn that no Bring back covers yet. */
  readonly hasNew: boolean;
}

const ACTIVE_OR_QUEUED_RUN_STATUSES = new Set<Run["status"]>([...ACTIVE_RUN_STATUSES, "queued"]);

function bringBackStatus(transfer: ContextTransfer, run: Run | undefined): BringBackStatus {
  switch (transfer.status) {
    case "consumed":
      if (run?.status === "rolled_back") return "rolled_back";
      return run !== undefined && ACTIVE_RUN_STATUSES.has(run.status) ? "sending" : "delivered";
    case "superseded":
      return "skipped";
    case "pending":
      // Merge-backs stored before they queued their own turn wait for the next message.
      return run === undefined || ACTIVE_OR_QUEUED_RUN_STATUSES.has(run.status)
        ? "queued"
        : "failed";
    default:
      return "failed";
  }
}

/** The Bring backs from one side chat or fork into its parent, read from the parent's records. */
export function deriveBringBacks(
  parent: Pick<Projection, "contextTransfers" | "runs">,
  source: Pick<Projection, "thread" | "runs">,
): BringBackState {
  const sourceOrdinals = new Map(source.runs.map((run) => [run.id, run.ordinal]));
  const records = parent.contextTransfers
    .filter(
      (transfer) => transfer.type === "merge_back" && transfer.sourceThreadId === source.thread.id,
    )
    .map((transfer): BringBackRecord => {
      const run = parent.runs.find((candidate) => candidate.id === transfer.targetRunId);
      const throughRunId = transfer.sourcePoint.runId ?? null;
      return {
        transferId: transfer.id,
        status: bringBackStatus(transfer, run),
        scope: transfer.mergeBackScope ?? "all",
        throughRunId,
        throughOrdinal: throughRunId === null ? null : (sourceOrdinals.get(throughRunId) ?? null),
        parentRunId: transfer.targetRunId,
        parentMessageId: run?.userMessageId ?? null,
        requestedAt: transfer.createdAt,
        deliveredAt: transfer.consumedAt,
        error: transfer.error,
      };
    });
  // Matches the server: an unbound merge-back from older versions does not block a new one.
  const throughOf = (statuses: ReadonlySet<BringBackStatus>) =>
    records.reduce(
      (through, record) =>
        statuses.has(record.status) && (record.status !== "queued" || record.parentRunId !== null)
          ? Math.max(through, record.throughOrdinal ?? 0)
          : through,
      0,
    );
  const includedThroughOrdinal = throughOf(new Set(["delivered", "sending"]));
  const requestedThroughOrdinal = throughOf(new Set(["delivered", "sending", "queued"]));
  const latestFinished = resolveLatestMergeBackRun(source);
  return {
    records,
    includedThroughOrdinal,
    requestedThroughOrdinal,
    hasNew: latestFinished !== null && latestFinished.ordinal > requestedThroughOrdinal,
  };
}

function resolveThreadProviderSession(projection: Projection): ProviderSession | null {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}

export function threadSteersDuringCompaction(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  return (
    resolveThreadProviderSession(projection)?.capabilities.turns.activeSteeringDuringCompaction ===
    true
  );
}

export function threadSupportsProviderHandoff(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  const session = resolveThreadProviderSession(projection);
  if (session !== null) {
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff;
  }
  if (resolveActiveThreadRun(projection) !== null) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;

  // Detaching a stopped session removes it from the projection. The server still
  // hands off from saved app history, which needs the source provider thread but
  // not its native ref.
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
}

export function getUserQueuedThreadRuns(
  projection: Pick<Projection, "runs" | "messages">,
): ReadonlyArray<Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.delegatedCompletion !== undefined || message.notification !== undefined,
      )
      .map((message) => message.id),
  );
  return projection.runs.filter(
    (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
  );
}

export function deriveThreadQueueWorkflowState(projection: Projection): ThreadQueueWorkflowState {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const activeMessage = projection.messages.find(
    (message) => message.id === activeRun?.userMessageId,
  );
  const promoteSkipsCompaction =
    activeMessage !== undefined && isCompactionCommandMessage(activeMessage);
  const hasSteerableProviderTurn =
    activeRun?.status === "running" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const queuedRuns = copySorted(
    getUserQueuedThreadRuns(projection),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return {
      run,
      // A queued guest message shows the guest's words; the agent still gets the attributed text.
      text: message?.context?.guest?.text ?? message?.text ?? "Queued message",
      attachments: message?.attachments ?? [],
      messageId: run.userMessageId,
      ...(message?.context ? { context: message.context } : {}),
      ...(message ? { message } : {}),
      bringsBack: projection.contextTransfers.some(
        (transfer) =>
          transfer.type === "merge_back" &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending",
      ),
    };
  });

  return {
    activeRun,
    queuedRuns,
    isHeld: projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
    canSendNow:
      activeRun === null &&
      projection.thread.archivedAt == null &&
      projection.thread.deletedAt == null,
    canPromoteToSteer:
      promoteSkipsCompaction ||
      ((activeRun?.status === "preparing" || activeRun?.status === "starting") &&
        (capabilities === undefined ||
          capabilities.supportsActiveSteering ||
          capabilities.supportsSteeringByInterruptRestart)) ||
      (hasSteerableProviderTurn &&
        (capabilities?.supportsActiveSteering === true ||
          capabilities?.supportsSteeringByInterruptRestart === true)),
    promoteSkipsCompaction,
  };
}

export function canForkProjectedAssistantItem(input: {
  readonly projectedItem: ThreadStructureVisibleTurnItem;
  readonly runStatus?: Run["status"] | undefined;
  readonly capabilities?: OrchestrationV2ProviderCapabilities | undefined;
}): boolean {
  const item = input.projectedItem.item;
  if (item.type !== "assistant_message" || item.runId === null || item.status !== "completed") {
    return false;
  }
  if (input.runStatus !== undefined && !FORKABLE_RUN_STATUSES.has(input.runStatus)) return false;
  if (input.capabilities === undefined) {
    // Historical and inherited rows may outlive their provider-session record.
    // Keep the portable server-side fallback available when capability evidence
    // is absent; a known incapable provider is rejected below.
    return true;
  }
  const capabilities = input.capabilities;
  const canForkNatively =
    capabilities.threads.canForkThread &&
    capabilities.threads.canForkFromTurn &&
    capabilities.identity.nativeThreadIds === "strong";
  return canForkNatively || capabilities.context.supportsFullThreadHandoff;
}

export function resolveLatestForkableAssistantItem(
  projection: Pick<Projection, "visibleTurnItems" | "runs">,
) {
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  return projection.visibleTurnItems.findLast((projectedItem) =>
    canForkProjectedAssistantItem({
      projectedItem,
      runStatus:
        projectedItem.item.runId === null
          ? undefined
          : runsById.get(projectedItem.item.runId)?.status,
    }),
  );
}

export function canDetachThreadProviderSession(projection: Projection): boolean {
  const session = resolveThreadProviderSession(projection);
  return session !== null && session.status !== "stopped" && session.status !== "error";
}
