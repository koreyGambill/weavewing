import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "~/composerDraftStore";

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
      getComposerDraft: (target: unknown) => {
        const count = mocks.counts.get(JSON.stringify(target)) ?? 0;
        return { reviewComments: Array.from({ length: count }) };
      },
    }),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));

const thread = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const queuedEdit = "queued-edit:thread-1:run-2" as DraftId;

async function setup() {
  vi.resetModules();
  mocks.counts.clear();
  mocks.listeners.clear();
  mocks.add.mockReset();
  mocks.update.mockReset();
  mocks.close.mockReset();
  const module = await import("./addedToMessageToast");
  const setCount = (target: unknown, count: number) => {
    mocks.counts.set(JSON.stringify(target), count);
    for (const listener of mocks.listeners) listener();
  };
  const clickShow = (options: { actionProps: { onClick: () => void } }) =>
    options.actionProps.onClick();
  return { ...module, setCount, clickShow };
}

describe("added-to-message toast", () => {
  it("updates one toast per draft and keeps drafts apart", async () => {
    const { announceAddedToMessage, setCount } = await setup();
    setCount(thread, 1);
    announceAddedToMessage(thread);
    setCount(thread, 2);
    announceAddedToMessage(thread);
    setCount(queuedEdit, 1);
    announceAddedToMessage(queuedEdit);

    expect(mocks.add).toHaveBeenCalledTimes(2);
    const threadToastId = mocks.add.mock.calls[0]?.[0].id;
    expect(mocks.update).toHaveBeenCalledWith(
      threadToastId,
      expect.objectContaining({ title: "2 comments in your next message" }),
    );
    expect(mocks.add.mock.calls[1]?.[0].id).not.toBe(threadToastId);
  });

  it("dismisses once the draft holds no comments, then starts fresh", async () => {
    const { announceAddedToMessage, setCount } = await setup();
    setCount(thread, 1);
    announceAddedToMessage(thread);
    const id = mocks.add.mock.calls[0]?.[0].id;

    setCount(thread, 0);
    expect(mocks.close).toHaveBeenCalledWith(id);

    setCount(thread, 1);
    announceAddedToMessage(thread);
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("dismisses when its composer stops showing the draft", async () => {
    const { announceAddedToMessage, composerTargetKey, registerComposerReveal, setCount } =
      await setup();
    const unregister = registerComposerReveal(composerTargetKey(thread), vi.fn());
    setCount(thread, 1);
    announceAddedToMessage(thread);

    unregister();
    expect(mocks.close).toHaveBeenCalledWith(mocks.add.mock.calls[0]?.[0].id);
  });

  it("Show reveals only the composer that owns the draft", async () => {
    const {
      announceAddedToMessage,
      composerTargetKey,
      registerComposerReveal,
      setCount,
      clickShow,
    } = await setup();
    const revealThread = vi.fn();
    const revealEdit = vi.fn();
    registerComposerReveal(composerTargetKey(thread), revealThread);
    registerComposerReveal(composerTargetKey(queuedEdit), revealEdit);
    setCount(queuedEdit, 1);
    announceAddedToMessage(queuedEdit);

    clickShow(mocks.add.mock.calls[0]![0]);
    expect(revealEdit).toHaveBeenCalledTimes(1);
    expect(revealThread).not.toHaveBeenCalled();
  });
});
