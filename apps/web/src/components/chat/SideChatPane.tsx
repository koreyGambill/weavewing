import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type BringBackRecord,
  deriveBringBacks,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2MergeBackScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ArrowUpRightIcon, ChevronDownIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { ComposerHandleContext } from "../../composerHandleContext";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { readLocalApi } from "../../localApi";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useNavigate } from "@tanstack/react-router";
import { useSideChatSource } from "./useSideChatSource";
import { BackgroundThreadContext } from "./backgroundThread";

const BRING_BACK_ROWS = 3;

const BRING_BACK_STATUS_LABELS: Record<BringBackRecord["status"], string> = {
  queued: "Queued in main thread",
  sending: "Sending to main thread",
  delivered: "Delivered to main thread",
  skipped: "Already delivered earlier",
  failed: "Not delivered",
  rolled_back: "Undone in main thread",
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
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose?: () => void;
  readonly inline?: boolean;
}) {
  const { parentRef, threadId } = props;
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(parentRef.environmentId, threadId), parentRef),
    [parentRef, threadId],
  );
  const shell = useQuietThreadShell(threadRef);
  const navigate = useNavigate();
  const source = useSideChatSource(threadRef, shell?.source ?? null, props.inline === true);
  const parent = useQuietThreadShell(parentRef);
  const snapshotLoaded = useEnvironmentShellHasSnapshot(parentRef.environmentId);
  const projection = useQuietThreadProjection(shell === null ? null : threadRef)?.projection;
  const parentProjection = useQuietThreadProjection(parent === null ? null : parentRef)?.projection;
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const cancelQueuedRun = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [bringingBack, setBringingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mergeRun = projection ? resolveLatestMergeBackRun(projection) : null;
  const bringBacks =
    projection && parentProjection ? deriveBringBacks(parentProjection, projection) : null;
  const unavailableReason = !canOperate
    ? "This connection cannot change threads."
    : mergeRun === null
      ? "Available after a finished reply."
      : null;
  const bringBackBlockedReason =
    unavailableReason ??
    (bringBacks?.hasNew === false
      ? `Nothing new since turn ${bringBacks.requestedThroughOrdinal}.`
      : null);
  const bringBackHint =
    bringBackBlockedReason ??
    (bringBacks !== null && bringBacks.requestedThroughOrdinal > 0
      ? `Sends turns ${bringBacks.requestedThroughOrdinal + 1}–${mergeRun?.ordinal} to the main thread, after its current work.`
      : `Sends this side chat through turn ${mergeRun?.ordinal} to the main thread, after its current work.`);

  const bringBack = async (scope: OrchestrationV2MergeBackScope) => {
    const blocked = scope === "all" ? unavailableReason : bringBackBlockedReason;
    if (blocked !== null || mergeRun === null || bringingBack) return;
    setBringingBack(true);
    const result = await mergeBack({
      environmentId: parentRef.environmentId,
      input: {
        sourceThreadId: threadId,
        targetThreadId: parentRef.threadId,
        runId: mergeRun.id,
        scope,
      },
    });
    setBringingBack(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: scope === "all" ? "Bringing back all of it" : "Bringing back",
        description: `Through turn ${mergeRun.ordinal}. The main thread gets it after its current work.`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not bring back the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
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
      environmentId: parentRef.environmentId,
      input: { threadId },
    });
    setDeleting(false);
    if (result._tag === "Success") {
      releaseComposerDraftUploads(threadRef);
      useComposerDraftStore.getState().clearDraftThread(threadRef);
      if (!props.inline) {
        useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadId}`);
      }
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
    <div data-side-chat-pane={threadId} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {shell?.title ?? "Side chat"}
        </span>
        {source ? (
          <Button variant="ghost" size="xs" onClick={source.open}>
            {source.label}
          </Button>
        ) : null}
        {props.inline ? (
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
                aria-disabled={bringBackBlockedReason !== null || bringingBack || undefined}
                onClick={() => void bringBack("additional")}
              >
                Bring back
              </Button>
            }
          />
          <TooltipPopup side="bottom">{bringBackHint}</TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="More ways to bring back"
                disabled={unavailableReason !== null || bringingBack}
              >
                <ChevronDownIcon />
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuItem onClick={() => void bringBack("all")}>
              Bring back all, through turn {mergeRun?.ordinal}
            </MenuItem>
          </MenuPopup>
        </Menu>
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
                  record.status === "queued" && record.parentRunId !== null && canOperate
                    ? () => {
                        const runId = record.parentRunId;
                        if (runId === null) return;
                        void cancelQueuedRun({
                          environmentId: parentRef.environmentId,
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
              environmentId={parentRef.environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
