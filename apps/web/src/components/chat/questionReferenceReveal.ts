import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { toastManager } from "../ui/toast";
import { questionReferenceElementId } from "./questionReferences";

export interface QuestionReferenceTarget {
  /** Set when the message holds the question's answer or comment block to scroll to. */
  readonly questionId?: string | undefined;
  readonly messageId: string;
}
type RevealListener = (target: QuestionReferenceTarget) => boolean;

// Keyed by scoped thread key, like question card reveals: a caller asks, the timeline scrolls.
const listeners = new Map<string, Set<RevealListener>>();
const pending = new Map<string, QuestionReferenceTarget>();

const MARK_DURATION_MS = 1600;
let marked: string | null = null;
let markTimer: ReturnType<typeof setTimeout> | undefined;
const markListeners = new Set<() => void>();

// One thread's ids can repeat in another environment or an inherited view, so the mark is scoped.
const markKey = (threadKey: string, elementId: string) => `${threadKey}\u0000${elementId}`;

function mark(key: string | null) {
  marked = key;
  for (const listener of markListeners) listener();
}

function subscribeMark(listener: () => void) {
  markListeners.add(listener);
  return () => markListeners.delete(listener);
}

// A message that only cites an item, or that an item names, is marked as a whole.
const messageMarkId = (messageId: string) => `message-reference-${messageId}`;

/** True while a reveal marks this user message as a whole in the thread `threadRef`. */
export function useMessageReferenceMark(
  threadRef: ScopedThreadRef | null,
  messageId: string,
): boolean {
  const key =
    threadRef === null ? null : markKey(scopedThreadKey(threadRef), messageMarkId(messageId));
  return useSyncExternalStore(
    subscribeMark,
    () => key !== null && marked === key,
    () => false,
  );
}

/** True while `revealQuestionReference` marks this block in the thread `threadRef`. */
export function useQuestionReferenceMark(
  threadRef: ScopedThreadRef | null,
  messageId: string,
  questionId: string,
): boolean {
  const key =
    threadRef === null
      ? null
      : markKey(scopedThreadKey(threadRef), questionReferenceElementId(messageId, questionId));
  return useSyncExternalStore(
    subscribeMark,
    () => key !== null && marked === key,
    () => false,
  );
}

/**
 * After the timeline scrolled a message row into view, brings its answer block into view too
 * when the row is taller than the viewport left room for. Does nothing for a block already shown.
 */
export function scrollQuestionReferenceIntoRow(
  list: LegendListRef | null,
  target: QuestionReferenceTarget,
  topOffset: number,
) {
  if (target.questionId === undefined) return;
  const scroller = list?.getScrollableNode();
  const block = scroller?.querySelector(
    `[id="${CSS.escape(questionReferenceElementId(target.messageId, target.questionId))}"]`,
  );
  const scroll = list?.getState?.().scroll;
  if (!list || !scroller || !block || typeof scroll !== "number") return;
  const view = scroller.getBoundingClientRect();
  const rect = block.getBoundingClientRect();
  if (rect.top >= view.top && rect.bottom <= view.bottom) return;
  void list.scrollToOffset({
    offset: scroll + rect.top - view.top - topOffset,
    animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
}

/**
 * Scrolls the thread's timeline to the block in `messageId` that answers or comments on
 * `questionId`, and marks it briefly. Works when the row is outside the rendered window; a
 * timeline that is not open yet serves the request when it mounts.
 *
 * @public For surfaces outside the timeline, such as question cards, to jump to a reply.
 */
export function revealQuestionReference(
  threadRef: ScopedThreadRef,
  questionId: string,
  messageId: string,
) {
  revealItemReference(threadRef, { label: questionId, messageId, questionId });
}

/**
 * Scrolls the thread's timeline to a user message about an item and marks it briefly: the
 * question's answer or comment block when `questionId` is set, otherwise the whole message.
 * `label` names the item, such as T2, when the message is not in the loaded part of the chat.
 */
export function revealItemReference(
  threadRef: ScopedThreadRef,
  input: { readonly label: string; readonly messageId: string; readonly questionId?: string },
) {
  const { label, messageId, questionId } = input;
  const threadKey = scopedThreadKey(threadRef);
  const target = { questionId, messageId };
  clearTimeout(markTimer);
  mark(
    markKey(
      threadKey,
      questionId === undefined
        ? messageMarkId(messageId)
        : questionReferenceElementId(messageId, questionId),
    ),
  );
  markTimer = setTimeout(() => mark(null), MARK_DURATION_MS);
  const current = listeners.get(threadKey);
  if (current === undefined || current.size === 0) {
    pending.set(threadKey, target);
    return;
  }
  pending.delete(threadKey);
  let revealed = false;
  for (const listener of current) revealed = listener(target) || revealed;
  if (!revealed)
    toastManager.add({
      type: "info",
      title: `That message about ${label} is not in the loaded part of the chat`,
      description: "Scroll up to load earlier messages, then try again.",
    });
}

/** Lets `revealQuestionReference` scroll this timeline, serving a request made before it loaded. */
export function useQuestionReferenceReveal(
  threadKey: string,
  rowCount: number,
  reveal: RevealListener,
) {
  const onReveal = useEffectEvent(reveal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the open timeline to question reference reveal requests
  useEffect(() => {
    const current = listeners.get(threadKey) ?? new Set();
    const listener: RevealListener = (target) => onReveal(target);
    current.add(listener);
    listeners.set(threadKey, current);
    return () => {
      current.delete(listener);
      if (current.size === 0) listeners.delete(threadKey);
    };
  }, [threadKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- serves a reveal requested while this timeline was not mounted or its rows not loaded
  useEffect(() => {
    const target = pending.get(threadKey);
    if (rowCount > 0 && target !== undefined && onReveal(target)) pending.delete(threadKey);
  }, [threadKey, rowCount]);
}
