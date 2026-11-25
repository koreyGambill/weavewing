import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ComposerContextId,
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  THREAD_QUESTIONS_ARTIFACT_ID,
  ThreadId,
  type ThreadQuestion,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  threadQuestionNoteImageDraftId,
  useComposerDraftStore,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { addQuestionAnswersToComposer } from "./questionComposer";
import { createQuestionDraftWriter, type QuestionDraft } from "./questionDraftWriter";
import { reconcileQuestionNoteImages } from "./questionNoteImages";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-notes"),
);
const heldDraft = (questionId: string) => threadQuestionNoteImageDraftId(threadRef, questionId);

const image = (id: string, name: string): ComposerImageAttachment => {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  return {
    type: "image",
    id,
    name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `data:${id}`,
    file,
  };
};

const chip = (questionId: string, note: string) => ({
  version: 1 as const,
  kind: "artifact-answer" as const,
  contextId: ComposerContextId.make(`answer_${questionId}`),
  label: questionId,
  artifactId: THREAD_QUESTIONS_ARTIFACT_ID,
  title: questionId,
  artifactVersion: 1,
  questionId,
  answerRevision: 1,
  question: `Prompt ${questionId}`,
  choice: "",
  note,
});

const question = (
  id: string,
  notes: string,
  extra: Partial<ThreadQuestion> = {},
): ThreadQuestion => ({
  id,
  prompt: `Prompt ${id}`,
  options: [],
  recommendedOptionIds: [],
  multiSelect: false,
  state: "open",
  createdAt: "2026-11-24T12:00:00.000Z",
  closedAt: null,
  answer: { chosenOptionIds: [], notes, submittedAt: null, draftRevision: 1 },
  answeredBy: null,
  replacedBy: null,
  ...extra,
});

const heldIds = (questionId: string) =>
  (useComposerDraftStore.getState().getComposerDraft(heldDraft(questionId))?.images ?? []).map(
    (entry) => entry.id,
  );
const composerIds = () =>
  (useComposerDraftStore.getState().getComposerDraft(threadRef)?.images ?? []).map(
    (entry) => entry.id,
  );

function reconcile(questions: ReadonlyArray<ThreadQuestion>) {
  const saves: Array<{ id: string; draft: QuestionDraft }> = [];
  const writer = createQuestionDraftWriter<ThreadWorkspace>();
  const saveDraft = async (id: string, draft: QuestionDraft) => {
    saves.push({ id, draft });
    return null;
  };
  reconcileQuestionNoteImages({
    threadRef,
    questions,
    chips: useComposerDraftStore.getState().getComposerDraft(threadRef)?.artifactAnswers ?? [],
    writer,
    saveDraft,
  });
  return saves;
}

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  store.addImages(heldDraft("Q1"), [
    image("q1-1", "Q1-image-1.png"),
    image("q1-2", "Q1-image-2.png"),
  ]);
});

describe("reconcileQuestionNoteImages", () => {
  it("drops held images whose markers the server cleared from the note", () => {
    // The agent's turn took a comment, so the note it marked is gone.
    reconcile([question("Q1", "", { discussedInMessageId: "message-1" as never })]);
    expect(heldIds("Q1")).toEqual([]);
  });

  it("keeps held images the note still marks, and those of a question the user dismissed", () => {
    reconcile([
      question("Q1", "[Q1 image 2]", { state: "withdrawn", userChangedAt: "2026-11-24T12:01Z" }),
    ]);
    expect(heldIds("Q1")).toEqual(["q1-2"]);
  });

  it("forgets every held image once the agent closes the question", () => {
    reconcile([question("Q1", "[Q1 image 1] [Q1 image 2]", { state: "replaced" })]);
    expect(heldIds("Q1")).toEqual([]);
  });

  it("saves the note without a marker whose image left the message", async () => {
    const store = useComposerDraftStore.getState();
    store.setArtifactAnswers(threadRef, [chip("Q1", "[Q1 image 1] [Q1 image 2]")]);
    store.removeImage(threadRef, "q1-1");
    const saves = reconcile([question("Q1", "[Q1 image 1] [Q1 image 2]")]);
    await vi.waitFor(() =>
      expect(saves).toEqual([{ id: "Q1", draft: { chosenOptionIds: [], notes: "[Q1 image 2]" } }]),
    );
    expect(heldIds("Q1")).toEqual(["q1-2"]);
  });
});

describe("addQuestionAnswersToComposer", () => {
  it("refuses a chip whose images would pass the attachment limit and changes nothing", () => {
    const store = useComposerDraftStore.getState();
    store.addImages(
      threadRef,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) =>
        image(`direct-${index}`, `direct-${index}.png`),
      ),
      { allowDuplicates: true },
    );
    const before = composerIds();
    expect(addQuestionAnswersToComposer(threadRef, [chip("Q1", "[Q1 image 1] [Q1 image 2]")])).toBe(
      false,
    );
    expect(composerIds()).toEqual(before);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.artifactAnswers).toEqual(
      [],
    );
    // One image fits.
    expect(addQuestionAnswersToComposer(threadRef, [chip("Q1", "[Q1 image 2]")])).toBe(true);
    expect(composerIds()).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  });
});
