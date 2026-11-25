import { threadQuestionReplaced } from "@t3tools/client-runtime/state/thread-questions";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadQuestionsWorkspace } from "../../state/threadQuestions";
import { ThreadQuestionCard } from "./ThreadQuestionCard";
import { threadQuestionElementId } from "./questionReveal";

/** The cards of the questions one `question_ask` call created, where the agent asked them. */
export function ThreadQuestionsTimelineRow({
  threadRef,
  questionIds,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly questionIds: ReadonlyArray<string>;
}) {
  const { workspace, error } = useThreadQuestionsWorkspace(threadRef, true);
  return (
    <div className="flex min-w-0 flex-col gap-2 px-1 py-0.5">
      {questionIds.map((id) => {
        const question = workspace?.questions.find((entry) => entry.id === id);
        return question ? (
          <ThreadQuestionCard
            key={id}
            question={question}
            threadRef={threadRef}
            replaces={threadQuestionReplaced(workspace?.questions ?? [], id)}
            inTimeline
          />
        ) : (
          <p
            key={id}
            id={threadQuestionElementId(id)}
            role="status"
            className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {workspace === null ? (error ?? `Loading ${id}…`) : `${id} is no longer available.`}
          </p>
        );
      })}
    </div>
  );
}
