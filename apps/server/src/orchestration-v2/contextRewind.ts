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
 * A rewind restarts the provider process, adds a model call and bills the summary as output, while
 * it saves only the removed tokens at the cached-read rate on each later step. Below this many
 * characters of removed tool results (about 5,000 tokens) it costs more than it saves.
 */
export const CONTEXT_REWIND_MIN_REMOVED_CHARS = 20_000;

export const isContextRewindContinuation = (origin: TurnOrigin | undefined): boolean =>
  origin?.kind === "system" && origin.event === CONTEXT_REWIND_ORIGIN.event;

function contextRewindContinuationText(removedToolCalls: number, summary: string): string {
  const calls = removedToolCalls === 1 ? "tool call" : `${removedToolCalls} tool calls`;
  return `<context-rewind>
You called context_rewind. Your last ${calls} and their results were removed from your context. This is the summary you wrote of what they found:

${summary}

Continue the task from here. Do not repeat those lookups unless the summary lacks something you need.
</context-rewind>`;
}

/** Sent in place of the continuation's claim when the rewind could not be applied. */
export function contextRewindNotAppliedText(continuation: string): string {
  return `The context rewind below did not take effect: your earlier tool calls and their results are still in your context. Continue the task from here.

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
