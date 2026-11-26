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

/** The tool a provider that rewinds whole turns offers in place of `context_rewind`. */
export const CONTEXT_REWIND_TURN_TOOL = "context_rewind_turn";

/**
 * What the model reads after a whole-turn rewind. The provider dropped the turn, so the user's
 * message for it is sent again just before this text, and the work done since then still happened.
 */
export function contextRewindTurnModelText(continuation: string, applied: boolean): string {
  const note = applied
    ? `You already worked on the message above, then called ${CONTEXT_REWIND_TURN_TOOL}. Everything you did since that message was removed from your context, and the summary below, which you wrote, replaces it. Files you changed and commands you ran still took effect. Continue the task from here. Do not repeat that work unless the summary lacks something you need.`
    : `Your ${CONTEXT_REWIND_TURN_TOOL} call did not take effect: your earlier tool calls and their results are still in your context. Continue the task from here.`;
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
