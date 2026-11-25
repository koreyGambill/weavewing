import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  sectionThreadQuestions,
  threadQuestionStatus,
} from "@t3tools/client-runtime/state/thread-questions";
import { threadQuestionTitle, type ScopedThreadRef, type ThreadQuestion } from "@t3tools/contracts";
import { useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { QuestionStatusBadge } from "./QuestionStatusBadge";
import { useQuestionsInComposer } from "./questionComposer";
import { requestQuestionReveal, threadQuestionElementId } from "./questionReveal";
import { compactListKeyTarget } from "./ThreadQuestionsCompactList.logic";

// Module-level, so React calls it once as the list opens and never refocuses it on a render.
// Opening the list hands it the keyboard, so the arrow keys move through questions.
const focusOnOpen = (element: HTMLDivElement | null) => element?.focus({ preventScroll: true });

/**
 * Waiting and deferred questions above the composer. Choosing a row, by click or arrow key,
 * scrolls the chat to that question's card; the list itself stays put.
 */
export function ThreadQuestionsCompactList({
  threadRef,
  questions,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly questions: ReadonlyArray<ThreadQuestion>;
  readonly onClose: () => void;
}) {
  const inComposer = useQuestionsInComposer(threadRef);
  const sections = sectionThreadQuestions(questions);
  const rows = [...sections.waiting, ...sections.deferred];
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = rows.find((row) => row.id === activeId)?.id ?? null;
  const optionId = (id: string) => `compact-${threadQuestionElementId(id)}`;

  const reveal = (id: string) => {
    setActiveId(id);
    document.getElementById(optionId(id))?.scrollIntoView({ block: "nearest" });
    if (requestQuestionReveal(scopedThreadKey(threadRef), id) === "missing")
      toastManager.add({
        type: "info",
        title: `${id} is not in the loaded part of the chat`,
        description: "Scroll up to load earlier messages, then try again.",
      });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const target = compactListKeyTarget(
      event.key,
      rows.map((row) => row.id),
      active,
    );
    if (target === null) return;
    event.preventDefault();
    reveal(target);
  };

  return (
    <div
      role="listbox"
      aria-label="Questions waiting"
      aria-activedescendant={active === null ? undefined : optionId(active)}
      tabIndex={0}
      ref={focusOnOpen}
      onKeyDown={onKeyDown}
      className="max-h-[min(15rem,35vh)] overflow-y-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {rows.map((question) => (
        <div
          key={question.id}
          id={optionId(question.id)}
          role="option"
          aria-selected={question.id === active}
          onClick={() => reveal(question.id)}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent",
            question.id === active && "bg-accent",
          )}
        >
          <span
            className={cn(
              "shrink-0 font-semibold tabular-nums",
              question.state === "open" ? "text-primary" : "text-muted-foreground",
            )}
          >
            {question.id}
          </span>
          <span className="min-w-0 flex-1 truncate">{threadQuestionTitle(question.prompt)}</span>
          <QuestionStatusBadge
            status={threadQuestionStatus(question, inComposer.get(question.id) === "answer")}
          />
        </div>
      ))}
    </div>
  );
}
