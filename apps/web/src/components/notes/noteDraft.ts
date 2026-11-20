import {
  THREAD_NOTES_IMAGE_MAX_BYTES,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { ThreadNote } from "@t3tools/contracts";
import { create } from "zustand";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { persistThreadNote, saveThreadNoteImage } from "../../state/threadNotes";

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

/**
 * Inserts on its own line where the cursor was when `prefix` preceded it, or at the end when the
 * text before the cursor changed meanwhile. Returns false when the draft now belongs to another file.
 */
export function insertNoteText(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  anchor: { readonly notePath: string; readonly prefix: string },
  insertion: string,
): boolean {
  const current = useDrafts.getState().entries[keyFor(environmentId, threadId)];
  if (!current || current.note.path !== anchor.notePath) return false;
  const index = current.text.startsWith(anchor.prefix) ? anchor.prefix.length : current.text.length;
  const before = current.text.slice(0, index);
  const after = current.text.slice(index);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after.startsWith("\n") ? "" : "\n";
  editNote(environmentId, threadId, { text: `${before}${lead}${insertion}${trail}${after}` });
  return true;
}

/** Saves one image for the note at `notePath` and returns its Markdown image link. */
export async function saveImageLink(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  notePath: string,
  file: File,
): Promise<string> {
  if (file.size > THREAD_NOTES_IMAGE_MAX_BYTES)
    throw new Error("Images in notes must be 10 MB or smaller.");
  const saved = await saveThreadNoteImage(environmentId, {
    threadId,
    dataUrl: await readFileAsDataUrl(file),
  });
  if (saved.notePath !== notePath)
    throw new Error("The notes directory changed while the image was saving.");
  const alt = file.name.replace(/\.[^.]+$/, "").replace(/[[\]\\]/g, "") || "image";
  return `![${alt}](${saved.path})`;
}
