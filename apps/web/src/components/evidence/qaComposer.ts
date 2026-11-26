import { qaCardTitle, qaKey, qaRef, type QaChange } from "@t3tools/client-runtime/qa-card";
import type {
  EvidenceLanding,
  ScopedThreadRef,
  WaitingItemContextRecord,
} from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import { useComposerDraftStore, useComposerWaitingItems } from "../../composerDraftStore";

/** The Discuss reference for one QA change, labelled `QA3 · discuss · <title>`. */
export function qaDiscussRecord(
  landing: Pick<EvidenceLanding, "id" | "target">,
  change: QaChange,
): WaitingItemContextRecord {
  const key = qaKey(landing.id, change.id);
  const ref = qaRef(change);
  const title = qaCardTitle(change);
  return {
    version: 1,
    kind: "waiting-item",
    contextId: toKindScopedComposerContextId("waiting-item", key),
    label: sanitizeComposerContextLabel(`${ref} · discuss · ${title}`, "waiting-item"),
    itemKind: "qa",
    key,
    ref,
    title: title.slice(0, 2048),
    sha: landing.target.sha,
  };
}

/** The keys of the QA changes this device's composer for the thread holds a Discuss for. */
export function useQaInComposer(threadRef: ScopedThreadRef | null): ReadonlySet<string> {
  const records = useComposerWaitingItems(threadRef);
  return new Set(records.flatMap((record) => (record.itemKind === "qa" ? [record.key] : [])));
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

/** Adds the change's Discuss reference to the composer and focuses it, or takes it out again. */
export function toggleQaDiscuss(
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

/** Takes a QA change's Discuss reference out of the composer, if it holds one. */
export function removeQaDiscuss(threadRef: ScopedThreadRef, key: string) {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(threadRef)?.waitingItems ?? [];
  const kept = current.filter((entry) => !(entry.itemKind === "qa" && entry.key === key));
  if (kept.length !== current.length) store.setWaitingItems(threadRef, kept);
}
