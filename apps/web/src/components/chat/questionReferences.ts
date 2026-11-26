import type { MessageId, OrchestrationMessageContext } from "@t3tools/contracts";
import {
  sentContextBlocks,
  sentMessageContext,
  threadQuestionReferenceMode,
} from "@t3tools/shared/sentContext";

/** A sent user message that answers or comments on a question. */
export interface QuestionReference {
  readonly messageId: MessageId;
  readonly mode: "answer" | "discuss";
}

/** The DOM id of the block in `messageId` that answers or comments on `questionId`. */
export const questionReferenceElementId = (messageId: string, questionId: string) =>
  `question-reference-${messageId}-${questionId}`;

/**
 * Where the loaded user messages answer or discuss `questionId`, oldest first. A message counts
 * only when its text references the record, because only those render a block to scroll to.
 */
export function threadQuestionReferences(
  messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly text: string;
    readonly context?: OrchestrationMessageContext | undefined;
  }>,
  questionId: string,
): QuestionReference[] {
  const references: QuestionReference[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !message.context) continue;
    for (const block of sentContextBlocks(sentMessageContext(message))) {
      const mode = threadQuestionReferenceMode(block.record);
      if (mode === null || block.record.kind !== "artifact-answer") continue;
      if (block.record.questionId !== questionId) continue;
      references.push({ messageId: message.id, mode });
    }
  }
  return references;
}
