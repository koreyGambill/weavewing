import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type BringBackRecord,
  deriveBringBacks,
} from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ArrowUpRightIcon, PanelsTopLeftIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { ComposerHandleContext } from "../../composerHandleContext";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import {
  bringSideChatToDraft,
  focusThreadDraft,
  showThreadConversation,
  type SideChatParentPanel,
} from "../../lib/sideChatPane";
import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { readLocalApi } from "../../localApi";
import { hostRightPanel } from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useNavigate } from "@tanstack/react-router";
import { useSideChatSource } from "./useSideChatSource";
import { SideChatContextButton } from "./SideChatContextButton";
import { BackgroundThreadContext } from "./backgroundThread";

const BRING_BACK_ROWS = 3;

const BRING_BACK_STATUS_LABELS: Record<BringBackRecord["status"], string> = {
  queued: "Queued in parent thread",
  sending: "Sending to parent thread",
  delivered: "Delivered to parent thread",
  skipped: "Already delivered earlier",
  failed: "Not delivered",
  rolled_back: "Undone in parent thread",
};

function BringBackRow(props: {
  readonly record: BringBackRecord;
  readonly onCancel: (() => void) | null;
}) {
  const { record } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const at = DateTime.formatIso(record.deliveredAt ?? record.requestedAt);
  const range =
    record.throughOrdinal === null
      ? null
      : `${record.scope === "all" ? "All, through" : "Through"} turn ${record.throughOrdinal}`;
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
          {range === null ? null : <span className="text-foreground">{range}</span>}
          {range === null ? "" : " · "}
          {BRING_BACK_STATUS_LABELS[record.status]} {formatRelativeTimeLabel(at)}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {[
            range,
            `Requested ${formatChatTimestampTooltip(DateTime.formatIso(record.requestedAt), timestampFormat)}`,
            record.deliveredAt === null
              ? null
              : `Delivered ${formatChatTimestampTooltip(DateTime.formatIso(record.deliveredAt), timestampFormat)}`,
            record.error,
          ].map((line) => (line === null ? null : <p key={line}>{line}</p>))}
        </TooltipPopup>
      </Tooltip>
      {props.onCancel === null ? null : (
        <InlineButton tone="muted" onClick={props.onCancel}>
          Cancel
        </InlineButton>
      )}
    </li>
  );
}

/** A side chat tab: its title, Bring back, Delete and Close, over the side chat's own chat. */
export default function SideChatPane(props: {
  readonly hostRef: ScopedThreadRef;
  readonly inlineParentRef?: ScopedThreadRef;
  readonly inlineDepth?: number;
  readonly onFocusParentComposer?: () => void;
  readonly onOpenTab?: () => void;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose?: () => void;
}) {
  const { hostRef, threadId, inlineParentRef } = props;
  const { environmentId } = hostRef;
  const inline = inlineParentRef !== undefined;
  const threadRef = scopeThreadRef(environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the viewing workspace as panel host
  useEffect(
    () => hostRightPanel(scopeThreadRef(environmentId, threadId), hostRef),
    [environmentId, hostRef, threadId],
  );
  const shell = useQuietThreadShell(threadRef);
  const parentId = shell?.source.lineage.parentThreadId;
  const parentRef = parentId == null ? null : scopeThreadRef(environmentId, parentId);
  const navigate = useNavigate();
  const source = useSideChatSource(
    threadRef,
    shell?.source ?? null,
    inline || parentId === hostRef.threadId,
  );
  const parent = useQuietThreadShell(parentRef);
  const parentTitle = parent?.title ?? "parent thread";
  const snapshotLoaded = useEnvironmentShellHasSnapshot(environmentId);
  const projection = useQuietThreadProjection(shell === null ? null : threadRef)?.projection;
  const parentProjection = useQuietThreadProjection(parentRef)?.projection;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const environment = useEnvironment(environmentId);
  const refreshAvailable =
    inline &&
    canOperate &&
    environment?.serverConfig?.environment.capabilities.sideChatContextRefresh === true;
  const cancelQueuedRun = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [deleting, setDeleting] = useState(false);
  const bringBacks =
    projection && parentProjection ? deriveBringBacks(parentProjection, projection) : null;
  const unavailableReason = !canOperate
    ? "This connection cannot change threads."
    : shell?.source.latestUserMessageAt == null
      ? "Available after the first message."
      : null;

  const bringBack = async () => {
    if (unavailableReason !== null || parentRef === null || shell === null) return;
    bringSideChatToDraft(parentRef, threadRef, shell.title);
    if (inlineParentRef?.threadId === parentRef.threadId) {
      props.onFocusParentComposer?.();
      return;
    }
    if (parentRef.threadId !== hostRef.threadId) {
      await navigate({ to: "/$environmentId/$threadId", params: parentRef });
    }
    focusThreadDraft(parentRef);
  };

  const deleteSideChat = async () => {
    if (!canOperate || shell === null || deleting) return;
    if (confirmThreadDelete) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Delete side chat "${shell.title}"?`,
            "This permanently clears its conversation history.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    setDeleting(true);
    const result = await deleteThread({
      environmentId,
      input: { threadId },
    });
    setDeleting(false);
    if (result._tag === "Success") {
      releaseComposerDraftUploads(threadRef);
      useComposerDraftStore.getState().clearDraftThread(threadRef);
      props.onClose?.();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not delete the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <div
      data-side-chat-pane={threadId}
      className={cn("flex min-h-0 flex-col", !inline && "h-full")}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1",
          inline ? "min-h-7 flex-wrap" : "h-9 border-b border-border pr-1 pl-3",
        )}
      >
        {inline ? null : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {shell?.title ?? "Side chat"}
          </span>
        )}
        {refreshAvailable ? (
          <SideChatContextButton threadKey={scopedThreadKey(threadRef)} showLabel />
        ) : null}
        {source ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              if (!inline && parentId === hostRef.threadId) showThreadConversation(hostRef);
              source.open();
            }}
          >
            {source.label}
          </Button>
        ) : null}
        {props.onOpenTab ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Open as side chat tab"
                  onClick={props.onOpenTab}
                >
                  <PanelsTopLeftIcon />
                </Button>
              }
            />
            <TooltipPopup side="bottom">Open as side chat tab</TooltipPopup>
          </Tooltip>
        ) : null}
        {inline || shell?.source.lineage.sideChatAnchor ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Open full chat"
                  onClick={() =>
                    void navigate({ to: "/$environmentId/$threadId", params: threadRef })
                  }
                >
                  <ArrowUpRightIcon />
                </Button>
              }
            />
            <TooltipPopup side="bottom">Open full chat</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Bring back to ${parentTitle}`}
                aria-disabled={unavailableReason !== null || parentRef === null || undefined}
                onClick={() => void bringBack()}
              >
                <span className="max-w-36 truncate">
                  {parent?.source.lineage.sideChat ? `Bring back to ${parentTitle}` : "Bring back"}
                </span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {unavailableReason ?? `Add a removable reference to the draft in ${parentTitle}`}
          </TooltipPopup>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Delete side chat"
          disabled={!canOperate || shell === null || deleting}
          onClick={() => void deleteSideChat()}
        >
          <Trash2Icon />
        </Button>
        {props.onClose ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close side chat"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {bringBacks !== null && bringBacks.records.length > 0 ? (
        <ul className="flex shrink-0 flex-col gap-0.5 border-b border-border px-3 py-1.5">
          {bringBacks.records
            .slice(-BRING_BACK_ROWS)
            .toReversed()
            .map((record) => (
              <BringBackRow
                key={record.transferId}
                record={record}
                onCancel={
                  record.status === "queued" &&
                  record.parentRunId !== null &&
                  canOperate &&
                  parentRef !== null
                    ? () => {
                        const runId = record.parentRunId;
                        if (runId === null) return;
                        void cancelQueuedRun({
                          environmentId,
                          input: { threadId: parentRef.threadId, runId },
                        });
                      }
                    : null
                }
              />
            ))}
        </ul>
      ) : null}
      {shell === null ? (
        snapshotLoaded ? (
          <p className="p-3 text-xs text-muted-foreground">This side chat was deleted.</p>
        ) : null
      ) : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={props.parentPanel}
              inlineSideChatDepth={props.inlineDepth ?? 0}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
