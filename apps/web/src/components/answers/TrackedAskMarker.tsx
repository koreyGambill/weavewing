import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareReplyIcon } from "lucide-react";

import { waitingCardsEnvironmentIdsAtom } from "../../state/threadQuestions";
import { revealAnswerInChat } from "../questions/questionReveal";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTrackedAsks } from "./trackedAnswers-web-state";

export function TrackedAskMarker({
  threadRef,
  messageId,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: MessageId;
}) {
  const enabled = useAtomValue(waitingCardsEnvironmentIdsAtom);
  const active = threadRef && enabled.includes(threadRef.environmentId) ? threadRef : null;
  const ask = useTrackedAsks(active).find((entry) => entry.askedInMessageId === messageId);
  if (!threadRef || !ask || ask.withdrawnBecause === "rollback") return null;
  const label = {
    queued: "Tracked · queued",
    owed: "Tracked · waiting on the agent",
    answered: "Answered",
    closed: "Got it",
    withdrawn: "Withdrawn",
  }[ask.state];
  const hasAnswer = ask.state === "answered" || ask.state === "closed";
  const latest = ask.answers.at(-1);
  const hint = latest
    ? `${ask.question} · ${new Date(latest.answeredAt).toLocaleString()}`
    : ask.question;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="me-1 flex items-center justify-end gap-1 text-xs text-muted-foreground" />
        }
      >
        <MessageSquareReplyIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="font-semibold">{ask.id}</span>
        <span aria-hidden="true">·</span>
        {hasAnswer && latest ? (
          <Button
            size="xs"
            variant="link"
            onClick={() => revealAnswerInChat(scopedThreadKey(threadRef), ask.id, latest.n)}
          >
            {label}
          </Button>
        ) : (
          <span>{label}</span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{hint}</TooltipPopup>
    </Tooltip>
  );
}
