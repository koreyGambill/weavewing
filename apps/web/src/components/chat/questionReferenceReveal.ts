import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { toastManager } from "../ui/toast";
import { questionReferenceElementId } from "./questionReferences";

export interface QuestionReferenceTarget {
  readonly questionId: string;
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

function mark(elementId: string | null) {
  marked = elementId;
  for (const listener of markListeners) listener();
}

function subscribeMark(listener: () => void) {
  markListeners.add(listener);
  return () => markListeners.delete(listener);
}

/**
 * True while `revealQuestionReference` marks this block. The block scrolls itself into view
 * when it mounts marked, because its row may have just been scrolled in from outside the list.
 */
export function useQuestionReferenceMark(messageId: string, questionId: string): boolean {
  const elementId = questionReferenceElementId(messageId, questionId);
  return useSyncExternalStore(
    subscribeMark,
    () => marked === elementId,
    () => false,
  );
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
  const threadKey = scopedThreadKey(threadRef);
  const target = { questionId, messageId };
  clearTimeout(markTimer);
  mark(questionReferenceElementId(messageId, questionId));
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
      title: `That reply to ${questionId} is not in the loaded part of the chat`,
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
