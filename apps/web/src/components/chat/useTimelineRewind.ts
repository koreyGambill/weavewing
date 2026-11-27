import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ForkHistoryPolicy,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  rewindToReplyPointRefusal,
  rewindToReplyThreadRefusal,
} from "@t3tools/shared/orchestrationV2RewindToReply";
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
import { toggleTrackAnswer } from "../answers/trackedAnswerDraft";
import { threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import { makeThreadErrorSetter } from "../ChatView.logic";
export interface RewindToReply {
  readonly disabledReason: (runId: RunId, messageId: MessageId) => string | null;
  readonly run: (runId: RunId, messageId: MessageId) => Promise<void>;
  /** Absent where the environment or this connection cannot rewind with a summary. */
  readonly runWithSummary?: (runId: RunId, messageId: MessageId) => Promise<void>;
}

const REWIND_WITH_SUMMARY_CONFIRMATION =
  "Rewind to this reply and keep a summary?\nThe agent first writes a summary of the later turns. Then this conversation continues from this reply, the later messages move into Earlier conversation, and the summary goes to the agent with your next message. Your files stay as they are.";

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
  readonly supportsRewindWithSummary: boolean;
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
  const busy = isSendBusy || isRevertingCheckpoint || phase === "running";
  const threadRefusal = busy
    ? "Finish the current turn and queued work before rewinding."
    : rewindToReplyThreadRefusal(serverProjection);
  if (threadRefusal !== null) return () => threadRefusal;
  // Rows keep this closure; holding only the fields it reads lets replaced structures be collected.
  const {
    thread,
    runs,
    attempts,
    providerThreads,
    providerTurns,
    providerSessions,
    runtimeRequests,
    contextTransfers,
    subagents,
    turnItems,
  } = serverProjection;
  const records = {
    thread,
    runs,
    attempts,
    providerThreads,
    providerTurns,
    providerSessions,
    runtimeRequests,
    contextTransfers,
    subagents,
    turnItems,
  };
  return (runId, messageId) => rewindToReplyPointRefusal(records, runId, messageId);
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
    supportsRewindWithSummary,
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
  const rewindWithSummary = useAtomCommand(orchestrationEnvironment.rewindWithSummary, {
    reportFailure: false,
  });
  const canRewindWithSummary =
    useAtomValue(orchestrationEnvironment.rewindWithSummary.permissionAtom(environmentId)) &&
    supportsRewindWithSummary;

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
    const tracked = serverProjection?.thread.trackedAsks?.find(
      (ask) => ask.askedInMessageId === message.id,
    );
    if (tracked === undefined ? message.context?.trackedAsk : tracked.state !== "withdrawn") {
      const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      if (draft?.trackedAnswer?.track !== true) toggleTrackAnswer(composerDraftTarget);
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
  const onRewindWithSummary = useStableCallback(async (runId: RunId, messageId: MessageId) => {
    const api = readLocalApi();
    if (!api || !activeThread || rewindToReplyDisabledReason(runId, messageId) !== null) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(REWIND_WITH_SUMMARY_CONFIRMATION),
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
    // Resolves after the agent's summary turn, so the composer waits as it does for a rewind.
    const result = await rewindWithSummary({
      environmentId,
      input: { threadId: activeThread.id, runId, replyMessageId: messageId },
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
        error instanceof Error ? error.message : "Could not rewind to this reply with a summary.",
      );
    }
  });
  return {
    rewindToReply: {
      disabledReason: rewindToReplyDisabledReason,
      run: onRewindToReply,
      ...(canRewindWithSummary ? { runWithSummary: onRewindWithSummary } : {}),
    },
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
  };
}
