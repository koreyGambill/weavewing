import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";

type ComposerTarget = ScopedThreadRef | DraftId;

interface OpenToast {
  readonly id: string;
  readonly unsubscribe: () => void;
}

const revealers = new Map<string, () => void>();
const openToasts = new Map<string, OpenToast>();
let toastSequence = 0;
// Explicit so an update restarts the countdown; base-ui keeps the old timer otherwise.
const TOAST_TIMEOUT_MS = 5_000;

export function composerTargetKey(target: ComposerTarget): string {
  return typeof target === "string" ? `draft:${target}` : `thread:${scopedThreadKey(target)}`;
}

function reviewCommentCount(target: ComposerTarget): number {
  return useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments.length ?? 0;
}

function release(key: string) {
  const open = openToasts.get(key);
  if (!open) return;
  openToasts.delete(key);
  open.unsubscribe();
}

function dismiss(key: string) {
  const open = openToasts.get(key);
  if (!open) return;
  release(key);
  toastManager.close(open.id);
}

/**
 * Lets the toast reach the composer that owns `key`. The returned cleanup runs when that composer
 * stops showing the draft, which also retires its toast so Show never lands on another composer.
 */
export function registerComposerReveal(key: string, reveal: () => void): () => void {
  revealers.set(key, reveal);
  return () => {
    if (revealers.get(key) === reveal) revealers.delete(key);
    dismiss(key);
  };
}

/** One confirmation per draft: repeat adds update it, and it closes once the draft holds none. */
export function announceAddedToMessage(target: ComposerTarget) {
  const key = composerTargetKey(target);
  const count = reviewCommentCount(target);
  const title = count > 1 ? `${count} comments in your next message` : "Added to your next message";
  const existing = openToasts.get(key);
  const id = existing?.id ?? `added-to-message:${++toastSequence}`;
  const options = {
    type: "success" as const,
    title,
    timeout: TOAST_TIMEOUT_MS,
    actionProps: {
      children: "Show",
      onClick: () => {
        dismiss(key);
        revealers.get(key)?.();
      },
    },
  };
  if (existing) {
    toastManager.update(id, options);
    return;
  }
  const unsubscribe = useComposerDraftStore.subscribe(() => {
    if (reviewCommentCount(target) === 0) dismiss(key);
  });
  openToasts.set(key, { id, unsubscribe });
  toastManager.add({ id, ...options, onClose: () => release(key) });
}
