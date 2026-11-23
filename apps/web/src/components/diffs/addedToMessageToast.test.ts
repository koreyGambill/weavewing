import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "~/composerDraftStore";

import { announceAddedToMessage } from "./addedToMessageToast";

const mocks = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  listeners: new Set<() => void>(),
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update, close: mocks.close },
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (target: unknown) => ({
        reviewComments: Array.from({ length: mocks.counts.get(JSON.stringify(target)) ?? 0 }),
      }),
    }),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));

// Module state outlives a test, so each test uses its own thread.
const threadRef = (id: string) => scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make(id));

type ToastOptions = {
  id: string;
  title: string;
  onClose: () => void;
};

function setup() {
  mocks.counts.clear();
  mocks.listeners.clear();
  mocks.add.mockReset();
  mocks.update.mockReset();
  mocks.close.mockReset();
  const setCount = (target: unknown, count: number) => {
    mocks.counts.set(JSON.stringify(target), count);
    for (const listener of mocks.listeners) listener();
  };
  const added = (index: number) => mocks.add.mock.calls[index]![0] as ToastOptions;
  return { setCount, added };
}

describe("added-to-message toast", () => {
  it("keeps one toast per draft whose count follows the draft", () => {
    const { setCount, added } = setup();
    const thread = threadRef("thread-a");
    setCount(thread, 1);
    announceAddedToMessage(thread);
    setCount(thread, 2);
    announceAddedToMessage(thread);

    expect(mocks.add).toHaveBeenCalledTimes(1);
    const id = added(0).id;
    expect(mocks.update).toHaveBeenLastCalledWith(id, {
      title: "2 comments in your next message",
      timeout: 5_000,
    });

    // A removal retitles without restarting the countdown.
    setCount(thread, 1);
    expect(mocks.update).toHaveBeenLastCalledWith(id, { title: "Added to your next message" });

    setCount(thread, 0);
    expect(mocks.close).toHaveBeenCalledWith(id);

    setCount(thread, 1);
    announceAddedToMessage(thread);
    expect(mocks.add).toHaveBeenCalledTimes(2);
  });

  it("starts fresh after the toast closes on its own", () => {
    const { setCount, added } = setup();
    const thread = threadRef("thread-b");
    setCount(thread, 1);
    announceAddedToMessage(thread);
    added(0).onClose();

    announceAddedToMessage(thread);
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(added(1).id).not.toBe(added(0).id);
  });

  it("keeps drafts apart and has no action", () => {
    const { setCount, added } = setup();
    const thread = threadRef("thread-c");
    const queuedEdit = "queued-edit:env-1:thread-c:run-3" as DraftId;
    setCount(thread, 1);
    announceAddedToMessage(thread);
    setCount(queuedEdit, 1);
    announceAddedToMessage(queuedEdit);

    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(added(0).id).not.toBe(added(1).id);
    expect(mocks.add.mock.calls[0]![0]).not.toHaveProperty("actionProps");
  });
});
