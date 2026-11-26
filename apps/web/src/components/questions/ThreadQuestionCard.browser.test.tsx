import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ThreadQuestion, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ThreadQuestionCard } from "./ThreadQuestionCard";

vi.mock(import("../../state/threadQuestions"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  return {
    ...actual,
    threadQuestionDraft: {
      ...actual.threadQuestionDraft,
      permissionAtom: () => Atom.make(true),
    } as never,
  };
});

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const answered: ThreadQuestion = {
  id: "Q8",
  prompt: "Which machine should agents drive?",
  options: [
    { id: "mac", label: "Mac only", description: "Works today" },
    { id: "pc", label: "Mac now, investigate the PC", description: "" },
  ],
  recommendedOptionIds: ["mac"],
  multiSelect: false,
  state: "answered",
  createdAt: "2026-11-24T12:00:00.000Z",
  closedAt: "2026-11-24T12:10:00.000Z",
  answer: {
    chosenOptionIds: ["pc"],
    notes: "Windows should work if possible.",
    submittedAt: "2026-11-24T12:05:00.000Z",
  },
  answeredBy: "user",
  replacedBy: null,
};

it("expands a closed question into the full card, read-only, with its answer chosen", async () => {
  // router: false because the card never navigates.
  await using screen = await render(
    <ThreadQuestionCard question={answered} threadRef={threadRef} />,
    { router: false },
  );
  await expect.element(screen.getByRole("radio")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Which machine/ }));

  const chosen = screen.getByRole("radio", { name: /investigate the PC/ });
  await expect.element(chosen).toBeChecked();
  await expect.element(chosen).toBeDisabled();
  await expect.element(screen.getByRole("radio", { name: /Mac only/ })).not.toBeChecked();
  await expect.element(screen.getByText("Recommended")).toBeVisible();
  await expect
    .element(screen.getByRole("paragraph"))
    .toHaveTextContent("Windows should work if possible.");
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Reopen" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: /Which machine/ }));
  await expect.element(screen.getByRole("radio")).not.toBeInTheDocument();
});

const longDescription =
  "Runs every agent on the Mac today, then measures whether the PC can take over the long builds.";

it("shows option descriptions in full until the card's toggle cuts them to one line", async () => {
  const question = {
    ...answered,
    options: [{ id: "mac", label: "Mac only", description: longDescription }, answered.options[1]!],
  };
  // router: false because the card never navigates.
  await using screen = await render(
    <div style={{ width: 280 }}>
      <ThreadQuestionCard question={question} threadRef={threadRef} />
    </div>,
    { router: false },
  );
  await userEvent.click(screen.getByRole("button", { name: /Which machine/ }));

  const description = screen.getByText(longDescription);
  const cutOff = () => description.element().scrollWidth > description.element().clientWidth;
  await expect.element(description).toBeVisible();
  expect(cutOff()).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "Collapse option descriptions" }));
  await vi.waitFor(() => expect(cutOff()).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "Expand option descriptions" }));
  await vi.waitFor(() => expect(cutOff()).toBe(false));
});

it("offers the description toggle only when an option has a description", async () => {
  const question = {
    ...answered,
    options: answered.options.map((option) => ({ ...option, description: "" })),
  };
  // router: false because the card never navigates.
  await using screen = await render(
    <ThreadQuestionCard question={question} threadRef={threadRef} />,
    { router: false },
  );
  await userEvent.click(screen.getByRole("button", { name: /Which machine/ }));
  await expect.element(screen.getByRole("radio", { name: /Mac only/ })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /option descriptions/ }))
    .not.toBeInTheDocument();
});

it("discusses an open question through a composer reference, with or without a note", async () => {
  const open: ThreadQuestion = {
    ...answered,
    state: "open",
    closedAt: null,
    answer: null,
    answeredBy: null,
  };
  function Card() {
    // Re-renders when the composer changes, as the timeline row does.
    useSyncExternalStore(useComposerDraftStore.subscribe, () =>
      useComposerDraftStore.getState().getComposerDraft(threadRef),
    );
    return <ThreadQuestionCard question={open} threadRef={threadRef} />;
  }
  const records = () =>
    useComposerDraftStore.getState().getComposerDraft(threadRef)?.waitingItems ?? [];
  // router: false because the card never navigates.
  await using screen = await render(<Card />, { router: false });
  const discuss = screen.getByRole("button", { name: "Discuss Q8" });
  await expect.element(discuss).toBeEnabled();

  await userEvent.click(discuss);
  await vi.waitFor(() =>
    expect(records().map((record) => [record.label, record.itemKind, record.key])).toEqual([
      ["Q8 · discuss · Which machine should agents drive?", "question", "Q8"],
    ]),
  );
  await expect.element(discuss).toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByText("In composer")).toBeVisible();
  // Nothing went in as an artifact answer or comment.
  expect(
    useComposerDraftStore.getState().getComposerDraft(threadRef)?.artifactAnswers ?? [],
  ).toEqual([]);

  await userEvent.click(discuss);
  await vi.waitFor(() => expect(records()).toEqual([]));
  await expect.element(discuss).toHaveAttribute("aria-pressed", "false");
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
});
