import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  isOrchestrationV2WorkActive,
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ForkHistoryPolicy,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newThreadId } from "~/lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import { makeThreadErrorSetter } from "../ChatView.logic";
export interface RewindToReply {
  readonly disabledReason: (runId: RunId, messageId: MessageId) => string | null;
  readonly run: (runId: RunId, messageId: MessageId) => Promise<void>;
}

interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly workspaceThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly supportsRewindToReply: boolean;
  readonly forkHistoryPolicy?: OrchestrationV2ForkHistoryPolicy;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

function getRewindToReplyDisabledReason({
  supportsRewindToReply,
  activeEnvironmentUnavailable,
  serverProjection,
  isSendBusy,
  isRevertingCheckpoint,
  phase,
}: Pick<
  TimelineRewindInput,
  | "supportsRewindToReply"
  | "activeEnvironmentUnavailable"
  | "serverProjection"
  | "isSendBusy"
  | "isRevertingCheckpoint"
  | "phase"
>): RewindToReply["disabledReason"] {
  if (!supportsRewindToReply) return () => "Update the environment to rewind to a reply.";
  if (activeEnvironmentUnavailable) return () => "Reconnect to this environment to rewind.";
  if (!serverProjection) return () => "Wait for the conversation to load.";
  const {
    thread,
    runs,
    attempts,
    providerThreads,
    providerTurns,
    providerSessions,
    turnItems,
    runtimeRequests,
    contextTransfers,
    subagents,
  } = serverProjection;
  if (
    isSendBusy ||
    isRevertingCheckpoint ||
    phase === "running" ||
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
    return () => "Finish the current turn and queued work before rewinding.";
  }
  return (runId, messageId) => {
    const run = runs.find((run) => run.id === runId);
    const reply = turnItems.findLast(
      (item) =>
        item.runId === runId &&
        item.type === "assistant_message" &&
        item.phase !== "commentary" &&
        item.phase !== "partial_answer",
    );
    if (
      run?.status !== "completed" ||
      reply?.type !== "assistant_message" ||
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
      (provider) => provider.id === thread.activeProviderThreadId,
    );
    if (provider?.driver !== "codex") return "Rewind to here requires native Codex history.";
    if (provider.goal?.status === "active") return "Pause the active goal before rewinding.";
    if (provider.pendingBackgroundTasks?.length)
      return "Finish provider background work before rewinding.";
    const attempt = attempts.find((attempt) => attempt.id === run.activeAttemptId);
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
      boundary.nativeTurnRef?.strength !== "strong" ||
      boundary.nativeTurnRef.nativeId === null
    ) {
      return "This reply and the later conversation need to share the active Codex session and have a native turn boundary.";
    }
    const capabilities = providerSessions.find(
      (session) => session.id === provider.providerSessionId,
    )?.capabilities;
    if (
      capabilities &&
      (!capabilities.threads.canForkThread || !capabilities.threads.canForkFromTurn)
    ) {
      return "This Codex installation does not support native forks at a turn boundary.";
    }
    return null;
  };
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer) and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    workspaceThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    phase,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    supportsRewindToReply,
    forkHistoryPolicy,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const rewindContext = useOrchestrationCommand(threadEnvironment.rewindContext, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    if (restoreFiles === undefined) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId });
      return;
    }

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      restoreFiles,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
      return;
    }
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = rewind.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const title = `${activeThread.title} fork`;
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title,
        ...(forkHistoryPolicy === undefined ? {} : { forkHistoryPolicy }),
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      useRightPanelStore
        .getState()
        .openRelatedThread(workspaceThreadRef, targetThreadRef, "fork", title);
    }
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  const rewindToReplyDisabledReason = getRewindToReplyDisabledReason({
    supportsRewindToReply,
    activeEnvironmentUnavailable,
    serverProjection,
    isSendBusy,
    isRevertingCheckpoint,
    phase,
  });
  const onRewindToReply = useStableCallback(async (runId: RunId, messageId: MessageId) => {
    const api = readLocalApi();
    if (
      !api ||
      !activeThread ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      rewindToReplyDisabledReason(runId, messageId) !== null
    )
      return;

    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        "Rewind to this reply?\nThis conversation will continue from this reply. Later messages will move into Earlier conversation. Your files and draft stay here.",
      ),
    );
    if (
      confirmed._tag === "Failure" ||
      !confirmed.value ||
      useComposerDraftStore.getState().rewindingThreadKeys.has(routeThreadKey)
    )
      return;
    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await rewindContext({
      environmentId,
      input: {
        sourceThreadId: activeThread.id,
        targetThreadId: newThreadId(),
        runId,
        replyMessageId: messageId,
      },
    }).finally(() => {
      useComposerDraftStore.setState((store) => {
        const remaining = new Set(store.rewindingThreadKeys);
        remaining.delete(routeThreadKey);
        return { rewindingThreadKeys: remaining };
      });
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Could not rewind to this reply.",
      );
    }
  });
  return {
    rewindToReply: { disabledReason: rewindToReplyDisabledReason, run: onRewindToReply },
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
  };
}
