import {
  CommandId,
  type MessageId,
  type OrchestrationV2Command,
  type ThreadId,
  type TurnOrigin,
} from "@t3tools/contracts";

/** The origin of the message that continues a turn after `context_rewind`. */
export const CONTEXT_REWIND_ORIGIN = { kind: "system", event: "context rewind" } as const;

/**
 * A rewind restarts the provider process and bills the summary as output, and one in a thread's
 * first turn writes the startup context to the prompt cache again. It saves only the removed
 * tokens on each later step, so below this many characters of removed tool results (about 15,000
 * tokens) it can cost more than it saves.
 */
export const CONTEXT_REWIND_MIN_REMOVED_CHARS = 60_000;

export const isContextRewindContinuation = (origin: TurnOrigin | undefined): boolean =>
  origin?.kind === "system" && origin.event === CONTEXT_REWIND_ORIGIN.event;

/** The saved continuation: true whether or not the cut applies, and readable in the thread. */
function contextRewindContinuationText(removedToolCalls: number, summary: string): string {
  const calls = removedToolCalls === 1 ? "1 tool call" : `${removedToolCalls} tool calls`;
  return `Context rewind: summary of ${calls}

${summary}`;
}

/**
 * What the model reads: the adapter says the calls were removed only when it reopened the
 * conversation at the cut (`removedToolCalls` set), and otherwise that its context still holds them.
 */
export function contextRewindModelText(
  continuation: string,
  removedToolCalls: number | undefined,
): string {
  const note =
    removedToolCalls === undefined
      ? "Your context_rewind call did not take effect: your earlier tool calls and their results are still in your context. Continue the task from here."
      : `You called context_rewind. Your last ${removedToolCalls === 1 ? "tool call" : `${removedToolCalls} tool calls`} and their results were removed from your context, and the summary below, which you wrote, replaces them. Continue the task from here. Do not repeat those lookups unless the summary lacks something you need.`;
  return `${note}

${continuation}`;
}

/** Queues the continuation behind the rewinding run, as the thread's own message. */
export function contextRewindContinuationCommand(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly removedToolCalls: number;
  readonly summary: string;
}): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> {
  return {
    type: "message.dispatch",
    origin: CONTEXT_REWIND_ORIGIN,
    commandId: CommandId.make(`command:${input.messageId}`),
    threadId: input.threadId,
    // A run a thread queues for itself continues the delegated task of the run that sent it.
    senderThreadId: input.threadId,
    messageId: input.messageId,
    text: contextRewindContinuationText(input.removedToolCalls, input.summary),
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  };
}

/** The origin of the request that asks the agent to summarize before a user's rewind. */
export const CONTEXT_REWIND_SUMMARY_ORIGIN = {
  kind: "system",
  event: "context rewind summary",
} as const;

const turnsLabel = (turns: number) => (turns === 1 ? "1 turn" : `${turns} turns`);

/** The first line of the stored summary, which the thread also shows as its title. */
export const contextRewindSummaryTitle = (turns: number) =>
  `Context rewind: summary of ${turnsLabel(turns)}`;

/**
 * The prompt for the summary turn. It names the reply the conversation returns to, because the
 * agent cannot see where the user clicked.
 */
export function contextRewindSummaryPrompt(input: {
  readonly turns: number;
  readonly replyExcerpt: string;
}): string {
  const excerpt = input.replyExcerpt.replace(/\s+/g, " ").trim();
  const shown = excerpt.length > 200 ? `${excerpt.slice(0, 197)}...` : excerpt;
  return `${contextRewindSummaryTitle(input.turns)}

The user is rewinding this conversation to your reply that begins "${shown}". The ${turnsLabel(input.turns)} after that reply, and this request, will leave your context. The summary you write now is all you will remember of them. Files stay as they are on disk.

Write that summary for your future self. Cover:
- what you learned, about the code, the environment and what the user wants;
- the files you created, changed or deleted, and the commands and other actions you ran that changed something, so you do not repeat them;
- the decisions made, with their reasons;
- what remains to do.

Keep exact file paths, identifiers, commands and URLs. Be brief. Reply with the summary only: do not call tools, change files or continue the task.`;
}

/** What the model reads with the user's next message after a rewind with a summary. */
export function contextRewindSummaryModelText(input: {
  readonly turns: number;
  readonly summary: string;
}): string {
  return `${contextRewindSummaryTitle(input.turns)}

${input.summary}

The user rewound the conversation to an earlier reply. The ${turnsLabel(input.turns)} after it were removed from your context, and the summary above, which you wrote, replaces them. Files were not restored: changes made in those turns are still on disk.`;
}
