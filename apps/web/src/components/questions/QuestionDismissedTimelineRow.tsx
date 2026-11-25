import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { threadQuestionUpdate } from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Where the user dismissed a question in the chat; Undo reopens it without starting a turn. */
export function QuestionDismissedTimelineRow({
  threadRef,
  questionId,
  title,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly questionId: string;
  readonly title: string;
}) {
  const canAct = useAtomValue(threadQuestionUpdate.permissionAtom(threadRef.environmentId));
  const update = useAtomCommand(threadQuestionUpdate);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, id: questionId, state: "open" },
    });
    setBusy(false);
  };
  return (
    <p className="flex min-w-0 items-center justify-center gap-1.5 px-1 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        You dismissed {questionId} · {title}
      </span>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button size="xs" variant="ghost" disabled={!canAct || busy} onClick={() => void undo()}>
            Undo
          </Button>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72">
          Reopen {questionId}. It returns to your count and starts no turn.
        </TooltipPopup>
      </Tooltip>
    </p>
  );
}
