import { threadQuestionTitle, type ScopedThreadRef } from "@t3tools/contracts";

import { useThreadQuestionsWorkspace } from "../../state/threadQuestions";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A row's count of questions waiting on the user; hovering lists them. */
export function ThreadQuestionCountChip({
  threadRef,
  count,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly count: number;
}) {
  const label = `${count} ${count === 1 ? "question" : "questions"} waiting on you`;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="info" size="sm" aria-label={label} />}>
        {count}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        <p className="font-medium">{label}</p>
        <WaitingQuestionList threadRef={threadRef} />
      </TooltipPopup>
    </Tooltip>
  );
}

// Mounted only while the tooltip is open, so a row fetches its questions on hover and never before.
function WaitingQuestionList({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { workspace, error } = useThreadQuestionsWorkspace(threadRef, true);
  if (workspace == null) return <p className="text-muted-foreground">{error ?? "Loading…"}</p>;
  const waiting = workspace.questions.filter((question) => question.state === "open");
  return (
    <ul className="mt-1 space-y-0.5">
      {waiting.map((question) => (
        <li key={question.id} className="flex min-w-0 gap-1.5">
          <span className="shrink-0 font-medium tabular-nums">{question.id}</span>
          <span className="min-w-0 break-words">{threadQuestionTitle(question.prompt)}</span>
        </li>
      ))}
    </ul>
  );
}
