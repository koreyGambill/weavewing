import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "~/composerDraftStore";

import { announceAddedToMessage } from "./addedToMessageToast";

const mocks = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  sessions: new Map<string, { environmentId: string; threadId: string }>(),
  listeners: new Set<() => void>(),
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update, close: mocks.close },
}));
vi.mock("~/lib/sideChatPane", () => ({ focusThreadDraft: vi.fn() }));
vi.mock("~/composerDraftStore", () => ({
  queuedRunEditThreadRef: (draftId: string) =>
    draftId.startsWith("queued-edit:") ? { environmentId: "env-1", threadId: "thread-2" } : null,
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (target: unknown) => ({
        reviewComments: Array.from({ length: mocks.counts.get(JSON.stringify(target)) ?? 0 }),
      }),
      getDraftSession: (draftId: string) => mocks.sessions.get(draftId) ?? null,
    }),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));

// Module state outlives a test, so each test uses its own thread.
const threadRef = (id: string) => scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make(id));
const queuedEdit = "queued-edit:env-1:thread-2:run-3" as DraftId;

type ToastOptions = {
  id: string;
  title: string;
  actionProps?: { onClick: () => void };
  onClose: () => void;
};

function setup() {
  mocks.counts.clear();
  mocks.sessions.clear();
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
    const open = vi.fn();
    setCount(thread, 1);
    announceAddedToMessage(thread, open);
    setCount(thread, 2);
    announceAddedToMessage(thread, open);

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
    announceAddedToMessage(thread, open);
    expect(mocks.add).toHaveBeenCalledTimes(2);
  });

  it("starts fresh after the toast closes on its own", () => {
    const { setCount, added } = setup();
    const thread = threadRef("thread-b");
    setCount(thread, 1);
    announceAddedToMessage(thread, vi.fn());
    added(0).onClose();

    announceAddedToMessage(thread, vi.fn());
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(added(1).id).not.toBe(added(0).id);
  });

  it("Show opens the destination captured when the comment was added", () => {
    const { setCount, added } = setup();
    const thread = threadRef("thread-c");
    const newThreadDraft = "draft-7" as DraftId;
    const open = vi.fn();
    mocks.sessions.set(newThreadDraft, { environmentId: "env-1", threadId: "draft-thread" });
    setCount(thread, 1);
    announceAddedToMessage(thread, open);
    setCount(newThreadDraft, 1);
    announceAddedToMessage(newThreadDraft, open);
    setCount(queuedEdit, 1);
    announceAddedToMessage(queuedEdit, open);
    mocks.sessions.clear();

    added(0).actionProps!.onClick();
    added(1).actionProps!.onClick();
    added(2).actionProps!.onClick();
    expect(open.mock.calls.map(([destination]) => destination)).toEqual([
      { threadRef: thread, draftId: null },
      { threadRef: { environmentId: "env-1", threadId: "draft-thread" }, draftId: newThreadDraft },
      { threadRef: { environmentId: "env-1", threadId: "thread-2" }, draftId: null },
    ]);
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });

  it("offers no Show for a draft it cannot route to", () => {
    const { setCount, added } = setup();
    const newThreadDraft = "draft-8" as DraftId;
    setCount(newThreadDraft, 1);
    announceAddedToMessage(newThreadDraft, vi.fn());
    expect(added(0).actionProps).toBeUndefined();
  });
});
