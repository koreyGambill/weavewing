import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { toastManager } from "~/components/ui/toast";
import { type DraftId, queuedRunEditThreadRef, useComposerDraftStore } from "~/composerDraftStore";
import { focusThreadDraft } from "~/lib/sideChatPane";
import { buildThreadRouteParams } from "~/threadRoutes";

type ComposerTarget = ScopedThreadRef | DraftId;

/** Where Show goes: a new thread's draft route when `draftId` is set, otherwise the thread route. */
export interface ShowDestination {
  readonly threadRef: ScopedThreadRef;
  readonly draftId: DraftId | null;
}

type OpenDestination = (destination: ShowDestination) => Promise<void> | void;

interface OpenToast {
  readonly id: string;
  count: number;
  readonly unsubscribe: () => void;
}

const openToasts = new Map<string, OpenToast>();
let toastSequence = 0;
// Explicit so a new add restarts the countdown; base-ui keeps the old timer otherwise.
const TOAST_TIMEOUT_MS = 5_000;

const targetKey = (target: ComposerTarget) =>
  typeof target === "string" ? `draft:${target}` : `thread:${scopedThreadKey(target)}`;

const titleFor = (count: number) =>
  count > 1 ? `${count} comments in your next message` : "Added to your next message";

function reviewCommentCount(target: ComposerTarget): number {
  return useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments.length ?? 0;
}

/** A queued-run edit draft resolves to its thread; Show opens the thread, not the edit. */
function resolveShowDestination(target: ComposerTarget): ShowDestination | null {
  if (typeof target !== "string") return { threadRef: target, draftId: null };
  const queuedEditThread = queuedRunEditThreadRef(target);
  if (queuedEditThread) return { threadRef: queuedEditThread, draftId: null };
  const session = useComposerDraftStore.getState().getDraftSession(target);
  if (!session) return null;
  return { threadRef: scopeThreadRef(session.environmentId, session.threadId), draftId: target };
}

function dismiss(key: string) {
  const open = openToasts.get(key);
  if (!open) return;
  openToasts.delete(key);
  open.unsubscribe();
  toastManager.close(open.id);
}

/** One confirmation per draft; its count follows the draft and it closes at zero or on send. */
export function announceAddedToMessage(target: ComposerTarget, openDestination: OpenDestination) {
  const key = targetKey(target);
  const count = reviewCommentCount(target);
  const existing = openToasts.get(key);
  if (existing) {
    existing.count = count;
    toastManager.update(existing.id, { title: titleFor(count), timeout: TOAST_TIMEOUT_MS });
    return;
  }
  const destination = resolveShowDestination(target);
  const id = `added-to-message:${++toastSequence}`;
  const unsubscribe = useComposerDraftStore.subscribe(() => {
    const open = openToasts.get(key);
    if (!open) return;
    const next = reviewCommentCount(target);
    if (next === 0) return dismiss(key);
    if (next === open.count) return;
    open.count = next;
    toastManager.update(open.id, { title: titleFor(next) });
  });
  openToasts.set(key, { id, count, unsubscribe });
  toastManager.add({
    id,
    type: "success",
    title: titleFor(count),
    timeout: TOAST_TIMEOUT_MS,
    ...(destination
      ? {
          actionProps: {
            children: "Show",
            onClick: () => {
              dismiss(key);
              void openDestination(destination);
            },
          },
        }
      : {}),
    onClose: () => {
      const open = openToasts.get(key);
      if (open?.id !== id) return;
      openToasts.delete(key);
      open.unsubscribe();
    },
  });
}

/** Show navigates like opening the thread from the sidebar, then reveals its main chat composer. */
export function useAnnounceAddedToMessage() {
  const navigate = useNavigate();
  return (target: ComposerTarget) =>
    announceAddedToMessage(target, async ({ threadRef, draftId }) => {
      await (draftId === null
        ? navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) })
        : navigate({ to: "/draft/$draftId", params: { draftId } }));
      focusThreadDraft(threadRef);
    });
}
