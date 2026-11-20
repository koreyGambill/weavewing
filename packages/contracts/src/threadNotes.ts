import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const THREAD_NOTES_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// Base64 grows bytes by 4/3; the slack covers the data URL header.
const THREAD_NOTES_IMAGE_DATA_URL_MAX_CHARS =
  Math.ceil((THREAD_NOTES_IMAGE_MAX_BYTES * 4) / 3) + 256;

export const ThreadNotesSettings = Schema.Struct({ directory: Schema.String });
export type ThreadNotesSettings = typeof ThreadNotesSettings.Type;
export const ThreadNote = Schema.Struct({
  threadId: ThreadId,
  path: Schema.String,
  text: Schema.String,
  revision: Schema.NullOr(Schema.String),
  includeThreadId: Schema.Boolean,
  resumeCommand: Schema.NullOr(Schema.String),
  resumeExplanation: Schema.String,
});
export type ThreadNote = typeof ThreadNote.Type;
export const ThreadNotesGetInput = Schema.Struct({ threadId: ThreadId });
export type ThreadNotesGetInput = typeof ThreadNotesGetInput.Type;
export const ThreadNotesSaveInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Schema.NullOr(Schema.String),
  text: Schema.String,
  includeThreadId: Schema.Boolean,
});
export type ThreadNotesSaveInput = typeof ThreadNotesSaveInput.Type;
export const ThreadNotesSettingsInput = Schema.Struct({});
export const ThreadNotesUpdateSettingsInput = ThreadNotesSettings;
export const ThreadNotesSendSelectionInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Schema.String,
  startIndex: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  endIndex: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type ThreadNotesSendSelectionInput = typeof ThreadNotesSendSelectionInput.Type;
export const ThreadNotesSaveImageInput = Schema.Struct({
  threadId: ThreadId,
  dataUrl: Schema.String.check(Schema.isMaxLength(THREAD_NOTES_IMAGE_DATA_URL_MAX_CHARS)),
});
export type ThreadNotesSaveImageInput = typeof ThreadNotesSaveImageInput.Type;
/** `path` is relative to `notePath`'s directory, ready for a Markdown image link. */
export const ThreadNotesSavedImage = Schema.Struct({
  notePath: Schema.String,
  path: Schema.String,
});
export type ThreadNotesSavedImage = typeof ThreadNotesSavedImage.Type;
export class ThreadNotesError extends Schema.TaggedError<ThreadNotesError>()("ThreadNotesError", {
  code: Schema.Literals(["storage", "conflict", "invalid", "thread", "send"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
