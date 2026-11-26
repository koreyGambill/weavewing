import {
  buildMessageRows,
  reactionInputsUnchanged,
  type InputMessageReaction,
} from "@t3tools/client-runtime/state/message-reactions";
import { nonUserMessageOrigin } from "@t3tools/client-runtime/user-message";
import type {
  MessageId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProjectedTurnItem,
  TurnOrigin,
} from "@t3tools/contracts";

import type { ThreadFeedMessage } from "../../lib/threadActivity";

export type IncomingOrigin = Exclude<TurnOrigin, { kind: "user" }>;

/**
 * The sender card for a message another thread, task or the app sent, or null for the user's own
 * messages. Only structured origins qualify; older servers' messages keep the bubble folds.
 */
export function incomingMessageCard(
  message: ThreadFeedMessage,
): { readonly origin: IncomingOrigin; readonly summary: string | undefined } | null {
  if (message.role !== "user") return null;
  const item = message.projectedItem?.item;
  const turnItem = item?.type === "user_message" ? item : undefined;
  if (turnItem?.origin === undefined && message.linkedSender === undefined) return null;
  const origin = nonUserMessageOrigin({ ...message, origin: turnItem?.origin });
  return origin === null ? null : { origin, summary: turnItem?.summary };
}

/**
 * Whether tapping a thread name can open it: its environment is connected here, and the thread
 * still exists. A lookup that is still running or failed leaves the link on.
 */
export function threadCardReachable(input: {
  readonly connected: boolean;
  readonly shellKnown: boolean;
  readonly lookup: "pending" | "found" | "missing" | "failed";
}): boolean {
  return input.connected && (input.shellKnown || input.lookup !== "missing");
}

type ReactionRun = Parameters<typeof buildMessageRows>[0][number];

/** Reuses the last reactions while only streamed assistant text moves. */
export function createMessageReactionReader() {
  let previous: {
    readonly runs: ReadonlyArray<ReactionRun>;
    readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
    readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    readonly reactions: ReadonlyMap<MessageId, InputMessageReaction>;
  } | null = null;
  return (
    runs: ReadonlyArray<ReactionRun>,
    nodes: ReadonlyArray<OrchestrationV2ExecutionNode>,
    rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  ): ReadonlyMap<MessageId, InputMessageReaction> => {
    if (
      previous !== null &&
      previous.runs === runs &&
      previous.nodes === nodes &&
      reactionInputsUnchanged(previous.rows, rows)
    ) {
      return previous.reactions;
    }
    const next = new Map<MessageId, InputMessageReaction>();
    for (const row of buildMessageRows(
      runs,
      rows.map(({ item }) => item),
      nodes,
    )) {
      if (row.reaction) next.set(row.message.messageId, row.reaction);
    }
    const reactions =
      previous !== null && sameReactions(previous.reactions, next) ? previous.reactions : next;
    previous = { runs, nodes, rows, reactions };
    return reactions;
  };
}

function sameReactions(
  left: ReadonlyMap<MessageId, InputMessageReaction>,
  right: ReadonlyMap<MessageId, InputMessageReaction>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, reaction] of right) {
    const other = left.get(id);
    if (other?.kind !== reaction.kind || other.tooltip !== reaction.tooltip) return false;
  }
  return true;
}
