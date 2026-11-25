type RevealListener = (questionId: string) => boolean;

// Keyed by scoped thread key: the panel asks, the thread's timeline scrolls its list.
const listeners = new Map<string, Set<RevealListener>>();

/**
 * Asks the open timeline of `threadKey` to scroll to the card of `questionId`; false when no
 * open timeline has it loaded.
 */
export function requestQuestionReveal(threadKey: string, questionId: string): boolean {
  let revealed = false;
  for (const listener of listeners.get(threadKey) ?? [])
    revealed = listener(questionId) || revealed;
  return revealed;
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
