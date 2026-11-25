import {
  THREAD_QUESTIONS_ARTIFACT_ID,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type RunId,
  type ThreadQuestion,
} from "@t3tools/contracts";

type Message = Pick<OrchestrationV2ConversationMessage, "id" | "role" | "createdBy" | "context">;
type Run = Pick<
  OrchestrationV2Run,
  "id" | "status" | "userMessageId" | "inputMessageIds" | "mergedIntoRunId"
>;

/** `received` once the provider accepted the turn carrying the answer; until then it is sent. */
export interface QuestionDelivery {
  readonly messageId: MessageId;
  readonly received: boolean;
}

/**
 * The runs whose turn a provider accepted: a provider turn exists for one of their attempts.
 * Provider turns are recorded only from the adapter's own events, so a start the adapter refused
 * leaves none, even though the run was already marked running with a start time.
 */
export function runsWithProviderTurn(
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>,
): ReadonlySet<RunId> {
  const accepted = new Set(providerTurns.map((turn) => turn.runAttemptId));
  return new Set(
    attempts.filter((attempt) => accepted.has(attempt.id)).map((attempt) => attempt.runId),
  );
}

type Reach = "none" | "sent" | "received";

function runReach(
  run: Run,
  runs: ReadonlyArray<Run>,
  accepted: ReadonlySet<RunId>,
  depth = 0,
): Reach {
  if (run.mergedIntoRunId !== undefined) {
    const target = runs.find((candidate) => candidate.id === run.mergedIntoRunId);
    return target === undefined || depth > 8 ? "none" : runReach(target, runs, accepted, depth + 1);
  }
  if (accepted.has(run.id)) return "received";
  // Not accepted yet: sent while the run can still start it, never delivered once it ended.
  return ["preparing", "queued", "starting", "running", "waiting"].includes(run.status)
    ? "sent"
    : "none";
}

function messageReach(
  message: Message,
  runs: ReadonlyArray<Run>,
  accepted: ReadonlySet<RunId>,
): Reach {
  let reach: Reach = "none";
  for (const run of runs) {
    if (run.userMessageId !== message.id && !run.inputMessageIds?.includes(message.id)) continue;
    const next = runReach(run, runs, accepted);
    if (next === "received") return next;
    if (next === "sent") reach = next;
  }
  return reach;
}

/**
 * Where each waiting question's current draft has gone: the user message carrying an answer
 * record for that draft revision and content, and whether a provider accepted that message's turn. A question whose
 * message was cancelled or edited to drop the record has no entry, so it waits on the user again.
 */
export function questionDeliveries(
  questions: ReadonlyArray<ThreadQuestion>,
  messages: ReadonlyArray<Message>,
  runs: ReadonlyArray<Run>,
  accepted: ReadonlySet<RunId>,
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
          record.answerRevision === (answer.draftRevision ?? 0) &&
          // A queued message edited under the same revision carries a different answer.
          record.choice ===
            question.options
              .filter((option) => answer.chosenOptionIds.includes(option.id))
              .map((option) => option.label)
              .join(", ") &&
          record.note === answer.notes,
      );
      if (!carries) continue;
      const reach = messageReach(message, runs, accepted);
      if (reach === "none") continue;
      deliveries.set(question.id, { messageId: message.id, received: reach === "received" });
      if (reach === "received") break;
    }
  }
  return deliveries;
}
