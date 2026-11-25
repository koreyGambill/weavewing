import {
  MESSAGE_BOOKMARK_NOTE_MAX_LENGTH,
  type EnvironmentId,
  type MessageFollowUp,
} from "@t3tools/contracts";
import { useState } from "react";

import { useMessageFollowUpUpdate } from "../../state/messageFollowUps";
import { textDirection } from "~/textDirection";
import { appendToThreadNote } from "../notes/noteDraft";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { bookmarkNoteBlock, bookmarkUpdate } from "./bookmarks.logic";

/**
 * Edits a bookmark's note. Cancel removes the note, as Cancel on a citation removes it; Escape
 * only closes. Notes also copies the quoted bookmark and its note into the thread's notes.
 */
export function BookmarkNoteEditor({
  environmentId,
  bookmark,
  onClose,
}: {
  environmentId: EnvironmentId;
  bookmark: MessageFollowUp;
  onClose: () => void;
}) {
  const [note, setNote] = useState(bookmark.note ?? "");
  const update = useMessageFollowUpUpdate();
  const tooLong = note.length > MESSAGE_BOOKMARK_NOTE_MAX_LENGTH;
  const saveNote = (text: string) =>
    update(environmentId, { ...bookmarkUpdate(bookmark, "note"), note: text });
  const save = () => {
    if (tooLong) return;
    if (note.trim() !== (bookmark.note ?? "")) void saveNote(note);
    onClose();
  };
  const remove = () => {
    if (bookmark.note !== undefined) void saveNote("");
    onClose();
  };
  const addToNotes = async () => {
    if (tooLong) return;
    onClose();
    if (note.trim() !== (bookmark.note ?? "")) void saveNote(note);
    try {
      await appendToThreadNote(environmentId, bookmark.threadId, bookmarkNoteBlock(bookmark, note));
      toastManager.add({ type: "success", title: "Added to thread notes" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add to thread notes",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <div
      className="w-72 p-2"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <textarea
        autoFocus
        aria-label="Bookmark note"
        aria-description="Enter to save; Shift+Enter for a new line."
        aria-invalid={tooLong || undefined}
        placeholder="Add a note..."
        rows={2}
        dir={textDirection(note)}
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            save();
          }
        }}
      />
      {tooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Notes can contain up to {MESSAGE_BOOKMARK_NOTE_MAX_LENGTH.toLocaleString()} characters.
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="xs"
          aria-label={bookmark.note === undefined ? "Cancel" : "Cancel and delete note"}
          onClick={remove}
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={tooLong}
          aria-label="Add to thread notes"
          onClick={() => void addToNotes()}
        >
          Notes
        </Button>
        <Button size="xs" disabled={tooLong} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
