import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ListItem,
  ThreadId,
  type ThreadListUpdateInput,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ThreadTaskCard } from "./ThreadTaskCard";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const filed: ListItem & { readonly ref: string } = {
  id: "task-rotate",
  text: "Rotate the staging webhook secret",
  state: "open",
  owner: "you",
  createdAt: "2026-11-25T10:00:00.000Z",
  doneAt: null,
  details: "The vault entry is staging/webhook.",
  parentId: null,
  links: [],
  ref: "T2",
};

// The task as the server holds it; the mocked list write changes it as the server would.
let task = filed;
const listeners = new Set<() => void>();
const sent: ThreadListUpdateInput[] = [];
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    async ({ input }: { input: ThreadListUpdateInput }) => {
      sent.push(input);
      const state = input.changes[0]?.state ?? task.state;
      task =
        state === "open"
          ? { ...filed, userChangedAt: "2026-11-25T11:00:00.000Z" }
          : { ...filed, state, settledBy: "user", userChangedAt: "2026-11-25T11:00:00.000Z" };
      for (const listener of listeners) listener();
      return { _tag: "Success", value: {} };
    }) as never,
}));
vi.mock(import("../../state/threadQuestions"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    threadTaskUpdate: { permissionAtom: () => Atom.make(true) } as never,
  };
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function Card() {
  const shown = useSyncExternalStore(subscribe, () => task);
  // Re-renders when the composer changes, as the timeline row does.
  useSyncExternalStore(useComposerDraftStore.subscribe, () =>
    useComposerDraftStore.getState().getComposerDraft(threadRef),
  );
  return <ThreadTaskCard threadRef={threadRef} task={shown} revision={3} inTimeline />;
}

/** Forgets what was sent, the task's changes and every draft when the test ends. */
function fresh(start: ListItem & { readonly ref: string } = filed): Disposable {
  sent.length = 0;
  task = start;
  return {
    [Symbol.dispose]: () => {
      sent.length = 0;
      task = filed;
      useComposerDraftStore.setState({ draftsByThreadKey: {} });
    },
  };
}

const records = () =>
  useComposerDraftStore.getState().getComposerDraft(threadRef)?.waitingItems ?? [];

it("marks a task done in one click, keeps focus on its line, and reopens it", async () => {
  using _fresh = fresh();
  await using screen = await render(<Card />);
  await expect
    .element(screen.getByRole("region", { name: "T2: Rotate the staging webhook secret" }))
    .toBeVisible();
  await expect.element(screen.getByText("The vault entry is staging/webhook.")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Done: T2" }));
  expect(sent).toEqual([
    {
      threadId: threadRef.threadId,
      expectedRevision: 3,
      changes: [{ id: "task-rotate", state: "done" }],
    },
  ]);
  const line = screen.getByRole("button", { name: /T2.*Rotate the staging webhook secret.*Done/ });
  await expect.element(line).toHaveFocus();
  await expect.element(screen.getByText("Done by you")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Reopen T2" }));
  expect(sent.at(-1)?.changes).toEqual([{ id: "task-rotate", state: "open" }]);
  await expect.element(screen.getByRole("button", { name: "Done: T2" })).toHaveFocus();
});

it("reaches Dismiss, Discuss and Done in order from the keyboard", async () => {
  using _fresh = fresh();
  await using screen = await render(<Card />);
  const dismiss = screen.getByRole("button", { name: "Dismiss T2" });
  (dismiss.element() as HTMLElement).focus();
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "Discuss T2" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "Done: T2" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(sent.at(-1)?.changes).toEqual([{ id: "task-rotate", state: "done" }]);
});

it("puts one Discuss reference in the composer, and Dismiss takes it out", async () => {
  using _fresh = fresh();
  await using screen = await render(<Card />);
  const discuss = screen.getByRole("button", { name: "Discuss T2" });

  await userEvent.click(discuss);
  await vi.waitFor(() =>
    expect(records().map((record) => [record.label, record.itemKind, record.key])).toEqual([
      ["T2 · discuss · Rotate the staging webhook secret", "task", "task-rotate"],
    ]),
  );
  await expect.element(discuss).toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByText("In composer")).toBeVisible();
  expect(sent).toEqual([]);

  // Dismiss takes no reason and starts no turn.
  await userEvent.click(screen.getByRole("button", { name: "Dismiss T2" }));
  expect(sent.at(-1)?.changes).toEqual([{ id: "task-rotate", state: "dropped" }]);
  await vi.waitFor(() => expect(records()).toEqual([]));
  await expect.element(screen.getByText("Cancelled", { exact: true })).toBeVisible();
});

it("shows what the agent recorded, with the user's words", async () => {
  using _fresh = fresh({
    ...filed,
    state: "done",
    settledBy: "agent",
    note: "done, rotated it",
  });
  await using screen = await render(<Card />);
  await expect.element(screen.getByText("Recorded by the agent")).toBeVisible();
  await expect.element(screen.getByText("“done, rotated it”")).toBeVisible();
});
