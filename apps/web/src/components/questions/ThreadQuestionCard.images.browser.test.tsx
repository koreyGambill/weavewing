import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ThreadQuestion, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { useComposerDraftStore } from "../../composerDraftStore";
import { render } from "../../../test/render";
import { ThreadQuestionCard } from "./ThreadQuestionCard";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-images"));

const question: ThreadQuestion = {
  id: "Q1",
  prompt: "Which layout should the settings page use?",
  options: [],
  recommendedOptionIds: [],
  multiSelect: false,
  state: "open",
  createdAt: "2026-11-24T12:00:00.000Z",
  closedAt: null,
  answer: null,
  answeredBy: null,
  replacedBy: null,
};

const saved = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    latest: null as ThreadQuestion | null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    show(next: ThreadQuestion | null) {
      this.latest = next;
      for (const listener of listeners) listener();
    },
  };
});

// The card's server calls answer as a server would: a draft save returns the saved workspace,
// and the card then renders the saved question, as a workspace refresh does in the app.
vi.mock(import("../../state/threadQuestions"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  let revision = 1;
  return {
    ...(await original()),
    threadQuestionDraft: { permissionAtom: () => Atom.make(true) } as never,
    useSaveQuestionDraft:
      () =>
      async (id: string, draft: { chosenOptionIds: ReadonlyArray<string>; notes: string }) => {
        revision += 1;
        const next: ThreadQuestion = {
          ...question,
          id,
          answer: {
            chosenOptionIds: [...draft.chosenOptionIds],
            notes: draft.notes,
            submittedAt: null,
            draftRevision: revision,
          },
        };
        saved.show(next);
        return {
          threadId: threadRef.threadId,
          revision,
          items: [],
          artifacts: [],
          summaryNotes: "",
          childPreamble: "",
          updatedAt: null,
          questions: [next],
        } as never;
      },
  };
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async () => null) as never,
}));

function SavedQuestionCard() {
  const shown = useSyncExternalStore(saved.subscribe, () => saved.latest) ?? question;
  return <ThreadQuestionCard question={shown} threadRef={threadRef} />;
}

/** Forgets the saved question and every draft when the test ends. */
function freshDrafts(): Disposable {
  return {
    [Symbol.dispose]: () => {
      saved.show(null);
      useComposerDraftStore.setState({ draftsByThreadKey: {} });
    },
  };
}

async function pngFile(): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 12;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#3366ff";
  context.fillRect(0, 0, 24, 12);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((png) => resolve(png!)));
  return new File([blob], "image.png", { type: "image/png" });
}

async function pasteImage(field: HTMLElement) {
  const transfer = new DataTransfer();
  transfer.items.add(await pngFile());
  field.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
}

const composerImageNames = () =>
  (useComposerDraftStore.getState().getComposerDraft(threadRef)?.images ?? []).map(
    (image) => image.name,
  );

it("holds a pasted image on the card and marks it in the note", async () => {
  using _drafts = freshDrafts();
  // router: false because the card never navigates.
  await using screen = await render(<SavedQuestionCard />, { router: false });
  const note = screen.getByRole("textbox", { name: "Note for Q1" });
  await userEvent.click(note);
  await pasteImage(note.element() as HTMLElement);

  await expect.element(screen.getByRole("img", { name: "[Q1 image 1]" })).toBeVisible();
  await expect.element(note).toHaveValue("[Q1 image 1]");
  await expect.element(screen.getByRole("button", { name: "Remove [Q1 image 1]" })).toBeVisible();
  // Nothing reaches the composer until the answer does.
  expect(composerImageNames()).toEqual([]);
});

it("puts the image in the composer with the answer and takes it out on Cancel", async () => {
  using _drafts = freshDrafts();
  // router: false because the card never navigates.
  await using screen = await render(<SavedQuestionCard />, { router: false });
  const note = screen.getByRole("textbox", { name: "Note for Q1" });
  await userEvent.click(note);
  await pasteImage(note.element() as HTMLElement);
  await expect.element(note).toHaveValue("[Q1 image 1]");

  await userEvent.click(screen.getByRole("button", { name: "Answer" }));
  await vi.waitFor(() => expect(composerImageNames()).toEqual(["Q1-image-1.png"]));

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(composerImageNames()).toEqual([]));
  await expect.element(screen.getByRole("img", { name: "[Q1 image 1]" })).toBeVisible();
  await expect.element(note).toHaveValue("[Q1 image 1]");
});

it("turns Discuss into Cancel while the note is in the composer", async () => {
  using _drafts = freshDrafts();
  // router: false because the card never navigates.
  await using screen = await render(<SavedQuestionCard />, { router: false });
  await userEvent.fill(screen.getByRole("textbox", { name: "Note for Q1" }), "Why a sidebar?");
  const composerChips = () =>
    (useComposerDraftStore.getState().getComposerDraft(threadRef)?.artifactAnswers ?? []).length;

  await userEvent.tab();
  await userEvent.click(screen.getByRole("button", { name: "Discuss" }));
  await vi.waitFor(() => expect(composerChips()).toBe(1));
  await expect.element(screen.getByRole("button", { name: "Discuss" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(composerChips()).toBe(0));
  await expect.element(screen.getByRole("button", { name: "Discuss" })).toBeVisible();
});
