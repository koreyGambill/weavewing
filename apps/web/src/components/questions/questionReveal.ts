type RevealListener = (questionId: string) => boolean;

// Keyed by scoped thread key: the panel asks, the thread's timeline scrolls its list.
const listeners = new Map<string, Set<RevealListener>>();
// A request no mounted timeline could serve yet, such as one whose chat tab is just opening.
const pending = new Map<string, string>();

/**
 * Asks the timeline of `threadKey` to scroll to the card of `questionId`. "missing" means an
 * open timeline does not have the card loaded; "pending" means no timeline is open yet, so the
 * next one to mount serves the request.
 */
export function requestQuestionReveal(
  threadKey: string,
  questionId: string,
): "revealed" | "missing" | "pending" {
  const current = listeners.get(threadKey);
  if (current === undefined || current.size === 0) {
    pending.set(threadKey, questionId);
    return "pending";
  }
  pending.delete(threadKey);
  let revealed = false;
  for (const listener of current) revealed = listener(questionId) || revealed;
  return revealed ? "revealed" : "missing";
}

/** Serves a request left pending for `threadKey`; true once a listener revealed it. */
export function servePendingQuestionReveal(threadKey: string, listener: RevealListener): boolean {
  const questionId = pending.get(threadKey);
  if (questionId === undefined || !listener(questionId)) return false;
  pending.delete(threadKey);
  return true;
}

export function subscribeQuestionReveal(threadKey: string, listener: RevealListener) {
  const current = listeners.get(threadKey) ?? new Set();
  current.add(listener);
  listeners.set(threadKey, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(threadKey);
  };
}

export const threadQuestionElementId = (questionId: string) => `thread-question-${questionId}`;
