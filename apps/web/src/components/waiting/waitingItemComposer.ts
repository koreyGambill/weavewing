import type {
  ScopedThreadRef,
  ThreadWorkspace,
  WaitingItemContextRecord,
} from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import { useComposerDraftStore, useComposerWaitingItems } from "../../composerDraftStore";
import { discussesStillWaiting } from "./waitingStrip.logic";

type ItemKind = WaitingItemContextRecord["itemKind"];

/**
 * The Discuss reference for one waiting item, labelled `<ref> · discuss · <title>`. A QA change
 * passes its landing's commit as `sha`.
 */
export function waitingItemDiscussRecord(item: {
  readonly itemKind: ItemKind;
  readonly key: string;
  readonly ref: string;
  readonly title: string;
  readonly sha?: string;
}): WaitingItemContextRecord {
  // QA keys keep their earlier ids, so a reference already in a draft still matches its card.
  const scopedKey = item.itemKind === "qa" ? item.key : `${item.itemKind}:${item.key}`;
  return {
    version: 1,
    kind: "waiting-item",
    contextId: toKindScopedComposerContextId("waiting-item", scopedKey),
    label: sanitizeComposerContextLabel(`${item.ref} · discuss · ${item.title}`, "waiting-item"),
    itemKind: item.itemKind,
    key: item.key,
    ref: item.ref,
    title: item.title.slice(0, 2048),
    ...(item.sha === undefined ? {} : { sha: item.sha }),
  };
}

/** The keys of one kind's items this device's composer for the thread holds a Discuss for. */
export function useWaitingItemsInComposer(
  threadRef: ScopedThreadRef | null,
  itemKind: ItemKind,
): ReadonlySet<string> {
  const records = useComposerWaitingItems(threadRef);
  return new Set(records.flatMap((record) => (record.itemKind === itemKind ? [record.key] : [])));
}

/** Focuses the composer in the same pane as `from`, so the user writes where the chip went. */
function focusNearestComposer(from: HTMLElement | null) {
  requestAnimationFrame(() => {
    for (let node = from?.parentElement ?? null; node !== null; node = node.parentElement) {
      const editor = node.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      if (editor) {
        editor.focus();
        // After the reference the store just appended, so the user's words follow it.
        const caret = document.createRange();
        caret.selectNodeContents(editor);
        caret.collapse(false);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(caret);
        return;
      }
    }
  });
}

/** Adds an item's Discuss reference to the composer and focuses it, or takes it out again. */
export function toggleWaitingItemDiscuss(
  threadRef: ScopedThreadRef,
  record: WaitingItemContextRecord,
  from: HTMLElement | null,
) {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(threadRef)?.waitingItems ?? [];
  const present = current.some((entry) => entry.contextId === record.contextId);
  store.setWaitingItems(
    threadRef,
    present
      ? current.filter((entry) => entry.contextId !== record.contextId)
      : [...current, record],
  );
  if (!present) focusNearestComposer(from);
}

/** Takes an item's Discuss reference out of the composer, if it holds one. */
export function removeWaitingItemDiscuss(
  threadRef: ScopedThreadRef,
  itemKind: ItemKind,
  key: string,
) {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(threadRef)?.waitingItems ?? [];
  const kept = current.filter((entry) => !(entry.itemKind === itemKind && entry.key === key));
  if (kept.length !== current.length) store.setWaitingItems(threadRef, kept);
}

/** Takes out the Discuss references of questions and tasks a workspace snapshot shows closed. */
export function syncWaitingItemDiscusses(
  threadRef: ScopedThreadRef,
  workspace: Pick<ThreadWorkspace, "questions" | "items">,
) {
  const store = useComposerDraftStore.getState();
  const next = discussesStillWaiting(
    store.getComposerDraft(threadRef)?.waitingItems ?? [],
    workspace,
  );
  if (next !== null) store.setWaitingItems(threadRef, next);
}

/** Takes every Discuss reference out of the composer, as when waiting cards are turned off. */
export function removeWaitingItemDiscusses(threadRef: ScopedThreadRef) {
  const store = useComposerDraftStore.getState();
  if ((store.getComposerDraft(threadRef)?.waitingItems ?? []).length > 0)
    store.setWaitingItems(threadRef, []);
}
