import { toastManager } from "../ui/toast";

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
function requestQuestionReveal(
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

/** Scrolls the thread's chat to a question's card, or says it is not in the loaded chat. */
export function revealQuestionInChat(threadKey: string, questionId: string) {
  if (requestQuestionReveal(threadKey, questionId) === "missing")
    toastManager.add({
      type: "info",
      title: `${questionId} is not in the loaded part of the chat`,
      description: "Scroll up to load earlier messages, then try again.",
    });
}

const QA_REVEAL_PREFIX = "qa:";

/** The landing a reveal request asks for, or null for a question's request. */
export const qaRevealLandingId = (target: string) =>
  target.startsWith(QA_REVEAL_PREFIX) ? target.slice(QA_REVEAL_PREFIX.length) : null;

/** Scrolls the thread's chat to the landing holding a QA change's card. */
export function revealQaInChat(
  threadKey: string,
  item: { readonly ref: string; readonly key: string },
) {
  const landingId = item.key.slice(0, Math.max(0, item.key.indexOf("/")));
  if (requestQuestionReveal(threadKey, `${QA_REVEAL_PREFIX}${landingId}`) === "missing")
    toastManager.add({
      type: "info",
      title: `${item.ref} is not in the loaded part of the chat`,
      description: "Scroll up to load earlier messages, or open Evidence to find it.",
    });
}

const TASK_REVEAL_PREFIX = "task:";

/** The task ref a reveal request asks for, or null for another kind's request. */
export const taskRevealRef = (target: string) =>
  target.startsWith(TASK_REVEAL_PREFIX) ? target.slice(TASK_REVEAL_PREFIX.length) : null;

export const threadTaskElementId = (ref: string) => `thread-task-${ref}`;

/**
 * Scrolls the thread's chat to a user task's card. A task whose card no open chat can show now,
 * such as one the user added in Checklist, opens Checklist instead, and leaves no request behind.
 */
export function revealTaskInChat(threadKey: string, ref: string, openChecklist: () => void) {
  const target = `${TASK_REVEAL_PREFIX}${ref}`;
  const result = requestQuestionReveal(threadKey, target);
  if (result === "revealed") return;
  if (pending.get(threadKey) === target) pending.delete(threadKey);
  openChecklist();
}

export function parseAnswerReveal(target: string) {
  if (target.startsWith("tracked-message:"))
    return { kind: "message", id: target.slice("tracked-message:".length) } as const;
  const answer = /^answer:(A[1-9][0-9]*):([1-9][0-9]*)$/.exec(target);
  return answer ? ({ kind: "answer", id: answer[1]!, n: Number(answer[2]) } as const) : null;
}

export function revealAnswerInChat(threadKey: string, id: string, revision: number) {
  requestQuestionReveal(threadKey, `answer:${id}:${revision}`);
}

export function revealTrackedMessageInChat(threadKey: string, messageId: string) {
  if (requestQuestionReveal(threadKey, `tracked-message:${messageId}`) === "missing")
    toastManager.add({ type: "info", title: "This message is earlier in the chat." });
}
