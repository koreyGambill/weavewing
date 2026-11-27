import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareReplyIcon } from "lucide-react";
import { useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { waitingCardsEnvironmentIdsAtom } from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTrackedAsks } from "./trackedAnswers-web-state";

const trackMessage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "answer:track",
  tag: WS_METHODS.threadTrackMessage,
});

export function TrackSentMessage({
  threadRef,
  message,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly message: ChatMessage;
}) {
  const environments = useAtomValue(waitingCardsEnvironmentIdsAtom);
  const eligible =
    threadRef !== null &&
    environments.includes(threadRef.environmentId) &&
    message.role === "user" &&
    message.createdBy === "user" &&
    (message.origin?.kind ?? "user") === "user" &&
    message.context?.guest === undefined;
  const asks = useTrackedAsks(eligible ? threadRef : null);
  const allowed = useAtomValue(trackMessage.permissionAtom(threadRef?.environmentId ?? null));
  const run = useAtomCommand(trackMessage, { label: "Track answer" });
  const [pending, setPending] = useState(false);
  const [written, setWritten] = useState(false);
  if (
    !eligible ||
    !allowed ||
    written ||
    message.context?.trackedAsk ||
    asks.some((ask) => ask.askedInMessageId === message.id)
  )
    return null;
  const onTrack = async () => {
    setPending(true);
    const result = await run({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, messageId: message.id },
    });
    setWritten(result._tag === "Success");
    setPending(false);
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={pending}
            aria-label="Track the answer"
            onClick={() => void onTrack()}
          />
        }
      >
        <MessageSquareReplyIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        Track the answer to this message. You get a card when the agent answers it.
      </TooltipPopup>
    </Tooltip>
  );
}
