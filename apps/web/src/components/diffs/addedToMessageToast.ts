import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";

type ComposerTarget = ScopedThreadRef | DraftId;

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

function dismiss(key: string) {
  const open = openToasts.get(key);
  if (!open) return;
  openToasts.delete(key);
  open.unsubscribe();
  toastManager.close(open.id);
}

/** One confirmation per draft; its count follows the draft and it closes at zero or on send. */
export function announceAddedToMessage(target: ComposerTarget) {
  const key = targetKey(target);
  const count = reviewCommentCount(target);
  const existing = openToasts.get(key);
  if (existing) {
    existing.count = count;
    toastManager.update(existing.id, { title: titleFor(count), timeout: TOAST_TIMEOUT_MS });
    return;
  }
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
    onClose: () => {
      const open = openToasts.get(key);
      if (open?.id !== id) return;
      openToasts.delete(key);
      open.unsubscribe();
    },
  });
}
