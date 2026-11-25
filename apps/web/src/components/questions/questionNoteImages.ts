import {
  isThreadQuestionRecord,
  nextThreadQuestionImageNumber,
  threadQuestionImageMarker,
  threadQuestionImageName,
  threadQuestionImagesWithoutMarkers,
  threadQuestionMarkersDroppedByChip,
  withoutThreadQuestionImageMarkers,
} from "@t3tools/client-runtime/state/thread-questions";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ArtifactAnswerContextRecord,
  type ScopedThreadRef,
  type ThreadQuestion,
  type ThreadWorkspace,
} from "@t3tools/contracts";

import {
  threadQuestionNoteImageDraftId,
  useComposerDraftStore,
  useComposerThreadDraft,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { randomUUID } from "~/lib/utils";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
  rememberComposerImageBytes,
} from "../chat/composerAttachmentFiles";
import { serializeComposerImages } from "../chat/composerImagePersistence";
import type { questionDraftWriter, SaveQuestionDraft } from "./questionDraftWriter";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** The images pasted into a question's note, waiting on its card. */
export function useQuestionNoteImages(
  threadRef: ScopedThreadRef,
  questionId: string,
): ReadonlyArray<ComposerImageAttachment> {
  return useComposerThreadDraft(threadQuestionNoteImageDraftId(threadRef, questionId)).images;
}

/** A paste or drop that carries an image, which the note box takes instead of the text. */
export function transferHasImage(files: ReadonlyArray<File>): boolean {
  return files.some((file) => classifyComposerAttachmentFile(file) !== "file");
}

/**
 * Prepares pasted images the way the composer does and holds them for the question, each named
 * for its marker. Calls `onHeld` with the markers for the note in the same step that holds the
 * images, and resolves with the last refusal, if any.
 * `note` is read once the images are ready, so a marker the user typed meanwhile is not reused.
 */
export async function holdQuestionNoteImages(input: {
  readonly threadRef: ScopedThreadRef;
  readonly questionId: string;
  readonly files: ReadonlyArray<File>;
  readonly note: () => string;
  readonly onHeld: (markers: ReadonlyArray<string>) => void;
}): Promise<{ readonly error: string | null }> {
  const { threadRef, questionId } = input;
  const draftId = threadQuestionNoteImageDraftId(threadRef, questionId);
  const store = useComposerDraftStore.getState();
  const thread = store.getComposerDraft(threadRef);
  const held = () => useComposerDraftStore.getState().getComposerDraft(draftId)?.images ?? [];
  let room =
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
    (thread?.images.length ?? 0) -
    (thread?.files.length ?? 0) -
    held().length;
  let error: string | null = null;
  const accepted: File[] = [];
  for (const file of input.files) {
    const kind = classifyComposerAttachmentFile(file);
    if (kind === "file") {
      error = `'${file.name}' is not an image. A question's note takes images only.`;
    } else if (kind === "unsupported-image") {
      error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
    } else if (room <= 0) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
    } else {
      room -= 1;
      accepted.push(normalizeComposerImageFileMimeType(file));
    }
  }
  const prepared: { file: File; bytes: Uint8Array | null }[] = [];
  for (const file of accepted) {
    const result = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES).catch(
      () => ({ ok: false, reason: "unreadable" }) as const,
    );
    if (!result.ok) {
      error =
        result.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach, even after compression.`;
      continue;
    }
    const bytes = await result.file
      .arrayBuffer()
      .then((buffer) => new Uint8Array(buffer))
      .catch(() => null);
    prepared.push({ file: result.file, bytes });
  }
  if (prepared.length === 0) return { error };

  // Numbered in one synchronous step, so overlapping pastes never take the same number.
  let number = nextThreadQuestionImageNumber(
    questionId,
    held().map((image) => image.name),
    input.note(),
  );
  const entries = prepared.map(({ file, bytes }) => {
    const extension = EXTENSIONS[file.type] ?? file.name.split(".").pop() ?? "img";
    const marker = threadQuestionImageMarker(questionId, number);
    const named = new File([file], threadQuestionImageName(questionId, number++, extension), {
      type: file.type,
      lastModified: file.lastModified,
    });
    if (bytes) rememberComposerImageBytes(named, bytes);
    const image: ComposerImageAttachment = {
      type: "image",
      id: randomUUID(),
      name: named.name,
      mimeType: named.type,
      sizeBytes: named.size,
      previewUrl: URL.createObjectURL(named),
      file: named,
    };
    return { image, marker };
  });
  const storedIds = new Set(
    store.addImages(
      draftId,
      entries.map(({ image }) => image),
      { allowDuplicates: true },
    ),
  );
  const markers = entries
    .filter(({ image }) => storedIds.has(image.id))
    .map(({ marker }) => marker);
  if (markers.length > 0) input.onHeld(markers);
  void persistHeldImages(draftId);
  return { error };
}

async function persistHeldImages(draftId: ReturnType<typeof threadQuestionNoteImageDraftId>) {
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  if (!draft) return;
  const serialized = await serializeComposerImages(draft.images, draft.persistedAttachments);
  // Only images still held: one removed while serializing stays removed.
  const current = new Set(
    (useComposerDraftStore.getState().getComposerDraft(draftId)?.images ?? []).map(
      (image) => image.id,
    ),
  );
  await useComposerDraftStore.getState().syncPersistedAttachments(
    draftId,
    serialized.filter((attachment) => current.has(attachment.id)),
  );
}

/** Takes held images off the question, and out of the thread's composer if they are there. */
export function dropQuestionNoteImages(
  threadRef: ScopedThreadRef,
  questionId: string,
  imageIds: ReadonlyArray<string>,
) {
  if (imageIds.length === 0) return;
  const store = useComposerDraftStore.getState();
  const inComposer = new Set(
    (store.getComposerDraft(threadRef)?.images ?? []).map((image) => image.id),
  );
  for (const imageId of imageIds) {
    store.removeImage(threadQuestionNoteImageDraftId(threadRef, questionId), imageId);
    if (inComposer.has(imageId)) store.removeImage(threadRef, imageId);
  }
}

/**
 * Keeps each question's note markers, held images and chip images in agreement: a marker whose
 * image left the message leaves the note, an image whose marker left the note is dropped, and a
 * question closed for good forgets its images (a dismissed one keeps them for Undo). Run after
 * the chips follow the same snapshot, so a closed question's images leave with its chip first.
 */
export function reconcileQuestionNoteImages(input: {
  readonly threadRef: ScopedThreadRef;
  readonly questions: ReadonlyArray<ThreadQuestion>;
  /** The thread composer's answer and comment chips. */
  readonly chips: ReadonlyArray<ArtifactAnswerContextRecord>;
  readonly writer: ReturnType<typeof questionDraftWriter>;
  readonly saveDraft: SaveQuestionDraft<ThreadWorkspace>;
}) {
  const { threadRef, writer } = input;
  const store = useComposerDraftStore.getState();
  const staged = new Map(
    input.chips.filter(isThreadQuestionRecord).map((record) => [record.questionId, record.note]),
  );
  for (const question of input.questions) {
    const draftId = threadQuestionNoteImageDraftId(threadRef, question.id);
    const held = store.getComposerDraft(draftId)?.images ?? [];
    const saved = {
      chosenOptionIds: question.answer?.chosenOptionIds ?? [],
      notes: question.answer?.notes ?? "",
    };
    // Edits waiting to save are newer than the snapshot, such as a marker just pasted.
    let note = writer.pending(question.id)?.notes ?? saved.notes;
    const chipNote = staged.get(question.id);
    if (chipNote !== undefined) {
      const dropped = threadQuestionMarkersDroppedByChip(
        question.id,
        note,
        chipNote,
        held.map((image) => image.name),
      );
      if (dropped.size > 0) {
        note = withoutThreadQuestionImageMarkers(question.id, note, dropped);
        void writer.edit(question.id, saved, { notes: note }, input.saveDraft);
      }
    }
    const closedForGood =
      question.state === "answered" ||
      question.state === "replaced" ||
      (question.state === "withdrawn" && question.userChangedAt === undefined);
    if (closedForGood && held.length > 0) {
      for (const image of held) {
        if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
      }
      store.clearComposerContent(draftId);
      continue;
    }
    dropQuestionNoteImages(
      threadRef,
      question.id,
      threadQuestionImagesWithoutMarkers(question.id, held, note),
    );
  }
}
