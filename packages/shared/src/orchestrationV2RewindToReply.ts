import {
  isOrchestrationV2WorkActive,
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";

type AssistantMessage = Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>;

/** The records Rewind to here reads; clients pass their thread structure, the server its projection. */
export type RewindToReplyProjection = Pick<
  OrchestrationV2ThreadProjection,
  | "runs"
  | "attempts"
  | "providerThreads"
  | "providerTurns"
  | "providerSessions"
  | "runtimeRequests"
  | "contextTransfers"
  | "subagents"
> & {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "id" | "contextRewind" | "activeProviderThreadId" | "modelSelection"
  >;
  /** Only the selected run's assistant messages are read. */
  readonly turnItems: ReadonlyArray<
    | Pick<
        AssistantMessage,
        "type" | "runId" | "phase" | "messageId" | "streaming" | "status" | "providerTurnId"
      >
    | {
        readonly type: Exclude<OrchestrationV2TurnItem["type"], "assistant_message">;
        readonly runId: RunId | null;
      }
  >;
};

/** Why the thread's current work blocks any rewind to a reply, or null when it is idle. */
export function rewindToReplyThreadRefusal(projection: RewindToReplyProjection): string | null {
  const { thread, runs, runtimeRequests, contextTransfers, subagents } = projection;
  if (
    runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    ) ||
    runtimeRequests.some((request) => request.status === "pending") ||
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    subagents.some((task) => isOrchestrationV2WorkActive(task.status))
  ) {
    return "Finish the current turn and queued work before rewinding.";
  }
  return null;
}

/**
 * Why the conversation cannot continue from this reply, or null when it can: the reply must end a
 * completed turn that later turns follow on the same native provider conversation.
 */
export function rewindToReplyPointRefusal(
  projection: RewindToReplyProjection,
  runId: RunId,
  messageId: MessageId,
): string | null {
  const { thread, runs, attempts, providerThreads, providerTurns, providerSessions, turnItems } =
    projection;
  const run = runs.find((candidate) => candidate.id === runId);
  const reply = turnItems.findLast(
    (item): item is Extract<(typeof turnItems)[number], { readonly type: "assistant_message" }> =>
      item.runId === runId &&
      item.type === "assistant_message" &&
      item.phase !== "commentary" &&
      item.phase !== "partial_answer",
  );
  if (
    run?.status !== "completed" ||
    reply === undefined ||
    reply.messageId !== messageId ||
    reply.streaming ||
    reply.status !== "completed"
  ) {
    return "Choose the final reply of a completed turn.";
  }
  const laterRuns = runs.filter(
    (later) =>
      later.ordinal > run.ordinal && later.startedAt !== null && later.status !== "rolled_back",
  );
  if (laterRuns.length === 0) return "There is no later conversation to move.";
  if (run.ordinal <= (thread.contextRewind?.runOrdinal ?? 0)) {
    return "This reply belongs to an earlier conversation.";
  }
  const provider = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  if (provider === undefined) return "Rewind to here needs the provider's saved conversation.";
  if (provider.goal?.status === "active") return "Pause the active goal before rewinding.";
  if (provider.pendingBackgroundTasks?.length)
    return "Finish provider background work before rewinding.";
  const attempt = attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const boundary =
    latestProviderTurnForAttempt(providerTurns, run.activeAttemptId) ??
    providerTurns.find((turn) => turn.id === attempt?.providerTurnId);
  if (
    run.providerThreadId !== provider.id ||
    laterRuns.some((later) => later.providerThreadId !== provider.id) ||
    provider.providerInstanceId !== thread.modelSelection.instanceId ||
    provider.nativeThreadRef?.strength !== "strong" ||
    provider.nativeThreadRef.nativeId === null ||
    provider.providerSessionId === null ||
    boundary?.status !== "completed" ||
    reply.providerTurnId !== boundary.id ||
    boundary.providerThreadId !== provider.id ||
    boundary.nativeTurnRef?.nativeId == null
  ) {
    return "This reply and the later conversation need to share the active provider session and have a native turn boundary.";
  }
  const capabilities = providerSessions.find(
    (session) => session.id === provider.providerSessionId,
  )?.capabilities;
  if (
    capabilities &&
    (!capabilities.threads.canForkThread || !capabilities.threads.canForkFromTurn)
  ) {
    return "This provider cannot fork its conversation at a reply.";
  }
  return null;
}
