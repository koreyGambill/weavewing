import {
  THREAD_QUESTIONS_ARTIFACT_ID,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type ThreadQuestion,
} from "@t3tools/contracts";

type Message = Pick<OrchestrationV2ConversationMessage, "id" | "role" | "createdBy" | "context">;
type Run = Pick<
  OrchestrationV2Run,
  "id" | "status" | "userMessageId" | "inputMessageIds" | "mergedIntoRunId" | "startedAt"
>;

/** `received` once the turn carrying the answer has started; until then the answer is sent. */
export interface QuestionDelivery {
  readonly messageId: MessageId;
  readonly received: boolean;
}

type Reach = "none" | "sent" | "received";

function runReach(run: Run, runs: ReadonlyArray<Run>, depth = 0): Reach {
  if (run.mergedIntoRunId !== undefined) {
    const target = runs.find((candidate) => candidate.id === run.mergedIntoRunId);
    return target === undefined || depth > 8 ? "none" : runReach(target, runs, depth + 1);
  }
  switch (run.status) {
    case "preparing":
    case "queued":
      return "sent";
    case "starting":
    case "running":
    case "waiting":
    case "completed":
    case "interrupted":
      return "received";
    case "failed":
    case "cancelled":
    case "rolled_back":
      // Cancelled or failed before it started, the turn never reached the agent.
      return run.startedAt === null ? "none" : "received";
  }
}

function messageReach(message: Message, runs: ReadonlyArray<Run>): Reach {
  let reach: Reach = "none";
  for (const run of runs) {
    if (run.userMessageId !== message.id && !run.inputMessageIds?.includes(message.id)) continue;
    const next = runReach(run, runs);
    if (next === "received") return next;
    if (next === "sent") reach = next;
  }
  return reach;
}

/**
 * Where each waiting question's current draft has gone: the user message carrying an answer
 * record for that draft revision, and whether that message's turn has started. A question whose
 * message was cancelled or edited to drop the record has no entry, so it waits on the user again.
 */
export function questionDeliveries(
  questions: ReadonlyArray<ThreadQuestion>,
  messages: ReadonlyArray<Message>,
  runs: ReadonlyArray<Run>,
): ReadonlyMap<string, QuestionDelivery> {
  const deliveries = new Map<string, QuestionDelivery>();
  for (const question of questions) {
    if (question.state !== "open" && question.state !== "deferred") continue;
    const answer = question.answer;
    if (answer === null) continue;
    for (const message of messages) {
      if (message.role !== "user" || message.createdBy !== "user") continue;
      const carries = message.context?.records.some(
        (record) =>
          record.kind === "artifact-answer" &&
          "artifactId" in record &&
          record.artifactId === THREAD_QUESTIONS_ARTIFACT_ID &&
          record.questionId === question.id &&
          record.answerRevision === (answer.draftRevision ?? 0),
      );
      if (!carries) continue;
      const reach = messageReach(message, runs);
      if (reach === "none") continue;
      deliveries.set(question.id, { messageId: message.id, received: reach === "received" });
      if (reach === "received") break;
    }
  }
  return deliveries;
}
