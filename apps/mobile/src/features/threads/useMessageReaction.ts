import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { InputMessageReaction } from "@t3tools/client-runtime/state/message-reactions";
import {
  EnvironmentId,
  ThreadId,
  type MessageId,
  type OrchestrationV2Run,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "../../state/threads";
import { createMessageReactionReader } from "./messageCards";

const EMPTY_REACTIONS: ReadonlyMap<MessageId, InputMessageReaction> = new Map();
const decodeThreadKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, ThreadId]));

const messageReactionsAtom = Atom.family((key: string) => {
  const ref = scopeThreadRef(...decodeThreadKey(JSON.parse(key)));
  const read = createMessageReactionReader();
  return Atom.make((get) => {
    const structure = get(environmentThreadDetails.quietThreadAtom(ref));
    if (structure === null) return EMPTY_REACTIONS;
    const runs: ReadonlyArray<OrchestrationV2Run> = structure.projection.runs;
    return read(
      runs,
      structure.projection.nodes,
      get(environmentThreadDetails.visibleTurnItemsAtom(ref)),
    );
  }).pipe(Atom.withLabel(`mobile-message-reactions:${key}`));
});

/** The chip for a message this thread received, derived from the turns that handled it. */
export function useMessageReaction(
  threadRef: ScopedThreadRef,
  messageId: MessageId,
): InputMessageReaction | undefined {
  return useAtomValue(
    messageReactionsAtom(JSON.stringify([threadRef.environmentId, threadRef.threadId])),
  ).get(messageId);
}
