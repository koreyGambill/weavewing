import { describe, expect, it, vi } from "vite-plus/test";

import {
  revealTaskInChat,
  servePendingQuestionReveal,
  subscribeQuestionReveal,
} from "./questionReveal";

describe("revealTaskInChat", () => {
  it("opens Checklist when no chat is open for the thread, and leaves no request behind", () => {
    const openChecklist = vi.fn();
    revealTaskInChat("env-1:closed", "T1", openChecklist);
    expect(openChecklist).toHaveBeenCalledOnce();
    // A chat that opens later does not scroll to a card the user was already shown elsewhere.
    const late = vi.fn(() => true);
    expect(servePendingQuestionReveal("env-1:closed", late)).toBe(false);
    expect(late).not.toHaveBeenCalled();
  });

  it("scrolls an open chat to the card without opening Checklist", () => {
    const openChecklist = vi.fn();
    const listener = vi.fn((target: string) => target === "task:T2");
    const unsubscribe = subscribeQuestionReveal("env-1:open", listener);
    revealTaskInChat("env-1:open", "T2", openChecklist);
    unsubscribe();
    expect(listener).toHaveBeenCalledWith("task:T2");
    expect(openChecklist).not.toHaveBeenCalled();
  });

  it("opens Checklist when the open chat does not have the card loaded", () => {
    const openChecklist = vi.fn();
    const unsubscribe = subscribeQuestionReveal("env-1:partial", () => false);
    revealTaskInChat("env-1:partial", "T3", openChecklist);
    unsubscribe();
    expect(openChecklist).toHaveBeenCalledOnce();
  });
});
