import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadNote } from "@t3tools/contracts";
import { create } from "zustand";
import { persistThreadNote } from "../../state/threadNotes";

interface Draft {
  note: ThreadNote;
  text: string;
  includeThreadId: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
}
const useDrafts = create<{ entries: Record<string, Draft> }>(() => ({ entries: {} }));
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Promise<ThreadNote>>();
const keyFor = (environmentId: EnvironmentId, threadId: ThreadId) => `${environmentId}:${threadId}`;
const set = (key: string, draft: Draft) =>
  useDrafts.setState((state) => ({ entries: { ...state.entries, [key]: draft } }));
export function useNoteDraft(environmentId: EnvironmentId, threadId: ThreadId) {
  return useDrafts((state) => state.entries[keyFor(environmentId, threadId)]);
}
export function receiveNote(environmentId: EnvironmentId, note: ThreadNote, discard = false) {
  const key = keyFor(environmentId, note.threadId);
  const current = useDrafts.getState().entries[key];
  if (!discard && current && (current.dirty || current.saving)) return;
  set(key, {
    note,
    text: note.text,
    includeThreadId: note.includeThreadId,
    dirty: false,
    saving: false,
    error: null,
  });
}
export async function flushNote(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<ThreadNote> {
  const key = keyFor(environmentId, threadId);
  clearTimeout(timers.get(key));
  timers.delete(key);
  const active = pending.get(key);
  if (active) {
    await active;
    return flushNote(environmentId, threadId);
  }
  const draft = useDrafts.getState().entries[key];
  if (!draft) throw new Error("The note is not loaded.");
  if (draft.error) throw new Error(draft.error);
  if (!draft.dirty) return draft.note;
  set(key, { ...draft, saving: true });
  const request = persistThreadNote(environmentId, {
    threadId,
    expectedRevision: draft.note.revision,
    text: draft.text,
    includeThreadId: draft.includeThreadId,
  });
  pending.set(key, request);
  try {
    const note = await request;
    const latest = useDrafts.getState().entries[key] ?? draft;
    const dirty = latest.text !== draft.text || latest.includeThreadId !== draft.includeThreadId;
    set(key, { ...latest, note, dirty, saving: false, error: null });
    return note;
  } catch (error) {
    const latest = useDrafts.getState().entries[key] ?? draft;
    set(key, {
      ...latest,
      saving: false,
      error: error instanceof Error ? error.message : "Could not save the note.",
    });
    throw error;
  } finally {
    pending.delete(key);
  }
}
export function editNote(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  update: { text?: string; includeThreadId?: boolean },
) {
  const key = keyFor(environmentId, threadId);
  const current = useDrafts.getState().entries[key];
  if (!current) return;
  set(key, { ...current, ...update, dirty: true });
  clearTimeout(timers.get(key));
  if (!current.error)
    timers.set(
      key,
      setTimeout(() => {
        void flushNote(environmentId, threadId).catch(() => {});
      }, 650),
    );
}

export async function retryNote(environmentId: EnvironmentId, threadId: ThreadId) {
  const key = keyFor(environmentId, threadId);
  const draft = useDrafts.getState().entries[key];
  if (draft) set(key, { ...draft, error: null });
  return flushNote(environmentId, threadId);
}

/** Inserts on its own line at `at`, clamped to the current text, so edits made while waiting survive. */
export function insertNoteText(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  at: number,
  insertion: string,
) {
  const current = useDrafts.getState().entries[keyFor(environmentId, threadId)];
  if (!current) return;
  const index = Math.min(at, current.text.length);
  const before = current.text.slice(0, index);
  const after = current.text.slice(index);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after.startsWith("\n") ? "" : "\n";
  editNote(environmentId, threadId, { text: `${before}${lead}${insertion}${trail}${after}` });
}
