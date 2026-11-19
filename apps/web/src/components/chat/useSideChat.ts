import type {
  ModelSelection,
  RuntimeMode,
  ScopedThreadRef,
  SideChatAnchor,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/**
 * Starts a side chat from a selected reply or the latest stable point. It applies the
 * parent composer's settings and sends the optional first prompt before opening the chat.
 * `open` resolves false when a side chat could not start or another is still starting.
 */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly anchoredThreadRef: ScopedThreadRef | null;
  readonly readSettings: () => {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onOpenAnchored: (threadId: ThreadId) => void;
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(error instanceof Error ? error.message : fallback);
  };
  const start = async (
    threadRef: ScopedThreadRef,
    prompt: string | undefined,
    anchor: SideChatAnchor | undefined,
  ) => {
    const { runtimeMode, modelSelection } = input.readSettings();
    const targetThreadId = newThreadId();
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        targetThreadId,
        title: "Side chat",
        ...(anchor === undefined ? {} : { anchor }),
      },
    });
    if (fork._tag === "Failure") {
      reportFailure(fork, "Could not start a side chat.");
      return false;
    }
    // Drops the empty side chat a failed start leaves behind; one that got its message stays.
    const discard = () =>
      void deleteThread({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, onlyIfUnused: true },
      });
    const targetRef = scopeThreadRef(threadRef.environmentId, targetThreadId);
    if (!(await waitForThreadShell(targetRef))) {
      input.onError("The side chat was created, but it did not reach this client.");
      discard();
      return false;
    }
    const sideChat = readThreadShell(targetRef);
    if (sideChat === null) {
      input.onError("The side chat is no longer available.");
      discard();
      return false;
    }
    if (runtimeMode !== sideChat.runtimeMode) {
      const mode = await setThreadRuntimeMode({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, runtimeMode, createdAt: new Date().toISOString() },
      });
      if (mode._tag === "Failure") {
        reportFailure(mode, "Could not set the side chat's permission mode.");
        discard();
        return false;
      }
    }
    const text = prompt?.trim();
    // Send before showing the tab: closing a tab whose side chat has no run deletes it.
    if (text) {
      const turn = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: {
            messageId: newMessageId(),
            origin: { kind: "user" as const },
            role: "user",
            text,
            attachments: [],
          },
          ...(modelSelection === undefined ? {} : { modelSelection }),
          titleSeed: deriveThreadTitleSeed({ text, attachments: [] }),
          runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (turn._tag === "Failure") {
        reportFailure(turn, "Could not send the side chat message.");
        discard();
        return false;
      }
    } else if (modelSelection !== undefined) {
      useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
    }
    if (anchor === undefined) {
      useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
    } else {
      input.onOpenAnchored(targetThreadId);
    }
    return true;
  };
  const open = async (prompt?: string, anchor?: SideChatAnchor) => {
    const threadRef = anchor === undefined ? input.threadRef : input.anchoredThreadRef;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, prompt, anchor).finally(() => {
      pendingRef.current = false;
    });
  };
  return { available: input.threadRef !== null, open: useStableCallback(open) };
}
