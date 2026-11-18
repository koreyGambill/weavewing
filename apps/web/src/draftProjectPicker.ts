import type { DraftId } from "./composerDraftStore";

const handlers = new Map<DraftId, () => void>();
let focusedDraftId: DraftId | null = null;

export function registerDraftProjectPicker(draftId: DraftId, open: () => void) {
  handlers.set(draftId, open);
  return () => {
    if (handlers.get(draftId) !== open) return;
    handlers.delete(draftId);
    if (focusedDraftId === draftId) focusedDraftId = null;
  };
}

export function focusDraftProjectPicker(draftId: DraftId | null) {
  focusedDraftId = draftId;
}

export function openDraftProjectPicker(fallbackDraftId: DraftId | null): boolean {
  const target = focusedDraftId ?? fallbackDraftId;
  const open = target ? handlers.get(target) : undefined;
  if (!open) return false;
  open();
  return true;
}
