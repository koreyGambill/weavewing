import {
  ThreadWorkspaceError,
  type IsoDateTime,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type TrackedAsk,
  type TrackedAnswer,
  type ThreadUpdateAskInput,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import { trackedAskAboutLine } from "@t3tools/provider-core/server/orchestrationInstructions";

export const invalidAsk = (message: string) =>
  new ThreadWorkspaceError({ code: "invalid", message });

export const missingAsk = (id: string) =>
  new ThreadWorkspaceError({ code: "not_found", message: `${id} does not exist in this thread.` });

export function addTrackedAsk(
  workspace: ThreadWorkspace,
  input: Pick<TrackedAsk, "question" | "askedInMessageId" | "about" | "createdAt">,
  state: "queued" | "owed",
) {
  const lastAskRef = (workspace.lastAskRef ?? 0) + 1;
  const ask: TrackedAsk = {
    ...input,
    id: `A${lastAskRef}`,
    state,
    closedAt: null,
    answers: [],
    followUps: [],
  };
  return { ask, workspace: { ...workspace, lastAskRef, asks: [...(workspace.asks ?? []), ask] } };
}

export function appendTrackedAnswer(
  ask: TrackedAsk,
  input: Omit<TrackedAnswer, "n">,
): TrackedAsk | ThreadWorkspaceError {
  switch (ask.state) {
    case "queued":
      return invalidAsk(`${ask.id} has not reached you yet.`);
    case "closed":
      return invalidAsk(
        `The user closed ${ask.id}. They reopen it if they want more, so do not answer it again.`,
      );
    case "withdrawn":
      return invalidAsk(`The user withdrew ${ask.id}.`);
    case "owed":
    case "answered":
      return {
        ...ask,
        state: "answered",
        answers: [...ask.answers, { ...input, n: (ask.answers.at(-1)?.n ?? 0) + 1 }],
      };
  }
}

export function updateTrackedAsk(
  ask: TrackedAsk,
  input: ThreadUpdateAskInput,
  at: IsoDateTime,
): TrackedAsk | ThreadWorkspaceError {
  switch (input.action) {
    case "close":
      if (ask.state === "answered")
        return { ...ask, state: "closed", closedAt: at, userChangedAt: at };
      break;
    case "reopen":
      if (ask.state === "closed")
        return { ...ask, state: "answered", closedAt: null, userChangedAt: at };
      break;
    case "withdraw":
      if (ask.state === "queued" || ask.state === "owed" || ask.state === "answered")
        return { ...ask, state: "withdrawn", withdrawnBecause: "user", userChangedAt: at };
      break;
    case "restore":
      if (ask.state === "withdrawn" && ask.withdrawnBecause === "user") {
        const { withdrawnBecause: _withdrawn, ...rest } = ask;
        return { ...rest, state: "owed", userChangedAt: at };
      }
      break;
    case "edit":
      if (ask.state === "queued" || ask.state === "owed")
        return { ...ask, question: input.question, userChangedAt: at };
      break;
  }
  return invalidAsk(`Cannot ${input.action} ${ask.id} while it is ${ask.state}.`);
}

export function rollBackTrackedAsk(
  ask: TrackedAsk,
  messages: ReadonlySet<MessageId>,
  runId: RunId,
): TrackedAsk {
  if (ask.state === "closed" || ask.withdrawnBecause === "user") return ask;
  const answers = ask.answers.filter((answer) => answer.runId !== runId);
  const followUps = ask.followUps.filter((entry) => !messages.has(entry.messageId));
  if (messages.has(ask.askedInMessageId))
    return { ...ask, answers, followUps, state: "withdrawn", withdrawnBecause: "rollback" };
  if (answers.length === ask.answers.length && followUps.length === ask.followUps.length)
    return ask;
  if (ask.state === "answered" && answers.length === 0)
    return { ...ask, answers, followUps, state: "owed" };
  if (ask.state === "owed" && followUps.length < ask.followUps.length && answers.length > 0)
    return { ...ask, answers, followUps, state: "answered" };
  return { ...ask, answers, followUps };
}

export function withTrackedAnswerContext(
  text: string,
  message: OrchestrationV2ConversationMessage,
  asks: ReadonlyArray<TrackedAsk>,
) {
  const lines = asks.flatMap((ask) => {
    if (ask.state !== "owed") return [];
    if (ask.askedInMessageId === message.id && message.context?.trackedAsk)
      return [trackedAskAboutLine(ask.id, ask.about?.ref)];
    if (ask.followUps.some((entry) => entry.messageId === message.id))
      return [
        `About ${ask.id}, your answer to ${JSON.stringify(ask.question)}: the user is following up, so ${ask.id} is owed again.`,
      ];
    return [];
  });
  return lines.length === 0 ? text : `${lines.join("\n")}\n\n${text}`;
}
