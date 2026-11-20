import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type ThreadNote,
  type ThreadNotesSaveInput,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { act, render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
const state = vi.hoisted(() => ({
  get: vi.fn(),
  settings: vi.fn(),
  save: vi.fn(),
  send: vi.fn(),
  saveImage: vi.fn(),
}));
vi.mock("../../state/threadNotes", () => ({
  threadNoteGet: state.get,
  threadNotesSettings: state.settings,
  persistThreadNote: state.save,
  sendThreadNoteSelection: state.send,
  saveThreadNoteImage: state.saveImage,
  updateThreadNotesSettings: "settings",
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
import { useComposerDraftStore } from "../../composerDraftStore";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { NotesPanel } from "./NotesPanel";

it("previews private drafts, saves before sharing a selected range, and retains a dirty draft on remount", async () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  const environmentId = EnvironmentId.make("notes-browser");
  const threadId = ThreadId.make("notes-browser");
  let note: ThreadNote = {
    threadId,
    path: "/notes/thread.md",
    text: "private before. share this. private after.",
    revision: "first",
    includeThreadId: true,
    resumeCommand: "codex resume 'native-id'",
    resumeExplanation: "Run on this environment.",
  };
  const atom = Atom.make(AsyncResult.success(note)).pipe(Atom.keepAlive);
  state.get.mockReturnValue(atom);
  state.settings.mockReturnValue(
    Atom.make(AsyncResult.success({ directory: "/notes" })).pipe(Atom.keepAlive),
  );
  let releaseSave = () => {};
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  state.save.mockImplementation(
    async (_environmentId: EnvironmentId, input: ThreadNotesSaveInput) => {
      await saveGate;
      note = {
        ...note,
        text: input.text,
        includeThreadId: input.includeThreadId,
        revision: "saved",
      };
      appAtomRegistry.set(atom, AsyncResult.success(note));
      return note;
    },
  );
  state.send.mockResolvedValue(note);
  await using view = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <NotesPanel environmentId={environmentId} threadId={threadId} />
    </RegistryContext.Provider>,
  );
  const field = page.getByRole("textbox", { name: "Personal thread notes" });
  await expect.element(field).toHaveValue(note.text);
  expect(state.send).not.toHaveBeenCalled();
  const markdown = "# Draft heading\n\n**Unsaved preview**";
  await field.fill(markdown);
  await page.getByRole("button", { name: "View notes", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Draft heading" })).toBeVisible();
  await expect.element(page.getByText("Unsaved preview")).toHaveProperty("tagName", "STRONG");
  await expect.element(field).not.toBeInTheDocument();
  expect(note.text).toBe("private before. share this. private after.");
  expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
  await page.getByRole("button", { name: "Edit notes", exact: true }).click();
  await expect.element(field).toHaveValue(markdown);
  await page.getByRole("button", { name: "Notes directory", exact: true }).click();
  await field.fill("private before. share this. private after. Updated");
  const element = field.element();
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("Expected textarea");
  await act(() => {
    element.focus();
    element.setSelectionRange(16, 26);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  });
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowLeft}{/Shift}");
  await page.getByRole("button", { name: "Add selection to chat" }).click();
  await expect.element(field).toBeDisabled();
  await expect
    .element(page.getByRole("checkbox", { name: "Include thread ID in file" }))
    .toBeDisabled();
  expect(state.send).not.toHaveBeenCalled();
  releaseSave();
  await vi.waitFor(() => {
    const draft =
      useComposerDraftStore.getState().draftsByThreadKey[
        scopedThreadKey({ environmentId, threadId })
      ];
    expect(draft?.reviewComments).toMatchObject([
      { filePath: "/notes/thread.md", text: "share this", startIndex: 16, endIndex: 26 },
    ]);
    expect(JSON.stringify(draft?.reviewComments)).not.toContain("private before");
  });
  expect(state.send).not.toHaveBeenCalled();
  expect(state.save).toHaveBeenCalled();
  await field.fill("Unsent text survives navigation");
  await view.unmount();
  await using reopened = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <NotesPanel environmentId={environmentId} threadId={threadId} />
    </RegistryContext.Provider>,
  );
  await expect
    .element(page.getByRole("textbox", { name: "Personal thread notes" }))
    .toHaveValue("Unsent text survives navigation");
  expect(reopened.container).toBeInTheDocument();
  expect(state.send).not.toHaveBeenCalled();
});

it("stores a pasted image beside the note and links it on its own line", async () => {
  const environmentId = EnvironmentId.make("notes-image");
  const threadId = ThreadId.make("notes-image");
  const note: ThreadNote = {
    threadId,
    path: "/notes/thread-abc.md",
    text: "before after",
    revision: "first",
    includeThreadId: false,
    resumeCommand: null,
    resumeExplanation: "Unavailable.",
  };
  state.get.mockReturnValue(Atom.make(AsyncResult.success(note)).pipe(Atom.keepAlive));
  state.settings.mockReturnValue(
    Atom.make(AsyncResult.success({ directory: "/notes" })).pipe(Atom.keepAlive),
  );
  state.saveImage.mockResolvedValue({ path: "thread-abc-images/0123.png" });
  await using _view = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <NotesPanel environmentId={environmentId} threadId={threadId} />
    </RegistryContext.Provider>,
  );
  const field = page.getByRole("textbox", { name: "Personal thread notes" });
  await expect.element(field).toHaveValue(note.text);
  const element = field.element();
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("Expected textarea");
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File(["png"], "Screen Shot.png", { type: "image/png" }));
  await act(() => {
    element.setSelectionRange(7, 7);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true }));
  });
  await expect
    .element(field)
    .toHaveValue("before \n![Screen Shot](thread-abc-images/0123.png)\nafter");
  expect(state.saveImage).toHaveBeenCalledWith(environmentId, {
    threadId,
    dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
  });
});
