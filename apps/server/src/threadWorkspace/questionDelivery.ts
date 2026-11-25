import {
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
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

/** A comment the user sent on a waiting question; `clearNote` once its turn took the note. */
export interface QuestionDiscussion {
  readonly messageId: MessageId;
  readonly clearNote: boolean;
}

/**
 * Where each waiting question's discussion is: the user message carrying a comment on its
 * current note, or else the message already recorded as discussing it once a provider accepted
 * its turn and its note was consumed, or the answer the agent reopened to discuss. Only an accepted turn clears the note, and only while the
 * draft still holds what was sent; a message whose run ended unstarted discusses nothing.
 */
export function questionDiscussions(
  questions: ReadonlyArray<ThreadQuestion>,
  messages: ReadonlyArray<Message>,
  runs: ReadonlyArray<Run>,
  accepted: ReadonlySet<RunId>,
): ReadonlyMap<string, QuestionDiscussion> {
  const discussions = new Map<string, QuestionDiscussion>();
  for (const question of questions) {
    if (question.state !== "open" && question.state !== "deferred") continue;
    const answer = question.answer;
    const recordOf = (message: Message, artifactId: string) =>
      message.role === "user" && message.createdBy === "user"
        ? message.context?.records.find(
            (record) =>
              record.kind === "artifact-answer" &&
              "artifactId" in record &&
              record.artifactId === artifactId &&
              record.questionId === question.id,
          )
        : undefined;
    const commentOf = (message: Message) => recordOf(message, THREAD_QUESTION_COMMENTS_ARTIFACT_ID);
    const isCurrent = (message: Message) => {
      const record = commentOf(message);
      return (
        answer !== null &&
        record !== undefined &&
        "answerRevision" in record &&
        record.answerRevision === (answer.draftRevision ?? 0) &&
        record.note === answer.notes &&
        answer.notes.trim() !== ""
      );
    };
    // The recorded message counts only once its note has gone; a queued one must still match. An
    // answer the agent reopened keeps its note, which the user can still send as an answer.
    const consumed = (message: Message) =>
      message.id === question.discussedInMessageId &&
      (((answer === null || answer.notes === "") && commentOf(message) !== undefined) ||
        recordOf(message, THREAD_QUESTIONS_ARTIFACT_ID) !== undefined);
    let found: QuestionDiscussion | undefined;
    for (const message of messages) {
      const current = isCurrent(message);
      if (!current && !consumed(message)) continue;
      const reach = messageReach(message, runs, accepted);
      if (reach === "none" || (!current && reach !== "received")) continue;
      const received = reach === "received";
      found = { messageId: message.id, clearNote: received && current };
      if (current && received) break;
    }
    if (found !== undefined) discussions.set(question.id, found);
  }
  return discussions;
}
