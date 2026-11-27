import {
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type EvidenceChangeQa,
  type MessageId,
  type OrchestrationMessageContext,
  type ThreadQuestion,
  type TrackedAsk,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/** The waiting item a card shows, as its references name it. */
export type ReferencedItem =
  | { readonly kind: "question"; readonly questionId: string }
  | { readonly kind: "qa"; readonly landingId: string; readonly changeId: string }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "answer"; readonly answerId: TrackedAsk["id"] };

/** One item's key in a reference index. */
export const referencedItemKey = (item: ReferencedItem): string => {
  switch (item.kind) {
    case "question":
      return `question:${item.questionId}`;
    case "qa":
      return `qa:${item.landingId}/${item.changeId}`;
    case "task":
      return `task:${item.taskId}`;
    case "answer":
      return `answer:${item.answerId}`;
  }
};

/**
 * Where a user message speaks about an item: `block` when it carries the item's answer or comment
 * block, `message` when it only cites the item or the item names it as the message it settled from.
 */
export interface ItemReference {
  readonly messageId: MessageId;
  readonly target: "block" | "message";
}

interface ReferenceSourceMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
  readonly context?: Pick<OrchestrationMessageContext, "records"> | undefined;
}

/**
 * Each item's references among `messages`, oldest first, keyed by `referencedItemKey`. A message
 * counts only for references its text cites, as only those render, and once per item. Only user
 * messages count.
 */
export function waitingItemReferenceIndex(
  messages: ReadonlyArray<ReferenceSourceMessage>,
): ReadonlyMap<string, ReadonlyArray<ItemReference>> {
  const index = new Map<string, ItemReference[]>();
  const add = (key: string, reference: ItemReference) => {
    const list = index.get(key);
    if (list === undefined) index.set(key, [reference]);
    else if (!list.some((entry) => entry.messageId === reference.messageId)) list.push(reference);
  };
  for (const message of messages) {
    if (message.role !== "user" || !message.context) continue;
    const cited = new Set(
      collectComposerContextReferences(message.text).map((entry) => entry.contextId),
    );
    for (const record of message.context.records) {
      if (!cited.has(record.contextId) || "payload" in record) continue;
      if (
        record.kind === "artifact-answer" &&
        (record.artifactId === THREAD_QUESTIONS_ARTIFACT_ID ||
          record.artifactId === THREAD_QUESTION_COMMENTS_ARTIFACT_ID)
      )
        add(`question:${record.questionId}`, { messageId: message.id, target: "block" });
      else if (record.kind === "waiting-item")
        add(`${record.itemKind}:${record.key}`, { messageId: message.id, target: "message" });
    }
  }
  return index;
}

/**
 * An item's references: those its loaded messages cite, plus the messages the item itself names,
 * such as the one an agent recorded its outcome from, when they are loaded and not cited. Ordered
 * as the messages are; the item's own pointers to messages that are not loaded are left out.
 */
export function itemReferences(input: {
  readonly index: ReadonlyMap<string, ReadonlyArray<ItemReference>>;
  readonly item: ReferencedItem;
  /** The loaded user messages in timeline order, for placing the item's own pointers. */
  readonly messageOrder: ReadonlyMap<string, number>;
  readonly pointers?: ReadonlyArray<MessageId | undefined>;
}): ReadonlyArray<ItemReference> {
  const cited = input.index.get(referencedItemKey(input.item)) ?? [];
  const extra = (input.pointers ?? []).flatMap((messageId): ItemReference[] =>
    messageId !== undefined &&
    input.messageOrder.has(messageId) &&
    !cited.some((entry) => entry.messageId === messageId)
      ? [{ messageId, target: "message" }]
      : [],
  );
  if (extra.length === 0) return cited;
  const unique = new Map([...cited, ...extra].map((entry) => [entry.messageId, entry]));
  return [...unique.values()].sort(
    (a, b) =>
      (input.messageOrder.get(a.messageId) ?? 0) - (input.messageOrder.get(b.messageId) ?? 0),
  );
}

/**
 * The messages a question names itself: the one that carried the user's answer, the one with
 * their latest comment, and the one an agent recorded an answer in prose from.
 */
export const questionPointers = (
  question: Pick<
    ThreadQuestion,
    "sentInMessageId" | "discussedInMessageId" | "settledFromMessageId"
  >,
): ReadonlyArray<MessageId | undefined> => [
  question.sentInMessageId,
  question.discussedInMessageId,
  question.settledFromMessageId,
];

/**
 * The messages a QA change names itself: only the user's Discuss message. The message an agent
 * recorded its outcome from is left out, because a landing re-recorded with a later landing time
 * can make that pointer name a later, unrelated message; messages that cite the card still count.
 */
export const qaPointers = (
  qa: Pick<EvidenceChangeQa, "discussedMessageId" | "messageId">,
): ReadonlyArray<MessageId | undefined> => [qa.discussedMessageId];

export const trackedAnswerPointers = (
  ask: Pick<TrackedAsk, "askedInMessageId" | "followUps">,
): ReadonlyArray<MessageId> => [
  ask.askedInMessageId,
  ...ask.followUps.map(({ messageId }) => messageId),
];

/**
 * Which reference the control shows next: the oldest first, then each following one, wrapping
 * after the last. `shown` is the one shown last, or null; a list that shrank starts over.
 */
export function nextReferencePosition(shown: number | null, count: number): number {
  return shown === null || shown < 0 || shown >= count - 1 ? 0 : shown + 1;
}
