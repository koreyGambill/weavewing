import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadQuestion } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  threadQuestionDraft,
  threadQuestionUpdate,
  useSaveQuestionDraft,
} from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { QuestionOptions } from "./QuestionOptions";
import { questionDraftWriter, type QuestionDraft } from "./questionDraftWriter";
import { requestQuestionReveal, threadQuestionElementId } from "./questionReveal";

const NOTE_SAVE_DELAY_MS = 600;

function stateLabel(question: ThreadQuestion): string {
  switch (question.state) {
    case "open":
      return "Open";
    case "deferred":
      return "Deferred";
    case "withdrawn":
      return "Dismissed";
    case "replaced":
      return "Replaced";
    case "answered":
      // An agent reads the user's prose; saying so lets a misreading show.
      return question.answeredBy === "agent"
        ? "Answered · recorded by the agent from your message"
        : "Answered · sent by you";
  }
}

/**
 * One agent question: answerable while open or deferred, its outcome once closed. Choosing an
 * option or typing a note saves a draft; sending happens from the review panel.
 */
export function ThreadQuestionCard({
  question,
  threadRef,
  actions,
  inTimeline = false,
}: {
  readonly question: ThreadQuestion;
  readonly threadRef: ScopedThreadRef;
  /** Extra header controls, such as the panel's Show in chat. */
  readonly actions?: ReactNode;
  readonly inTimeline?: boolean;
}) {
  const canAct = useAtomValue(threadQuestionDraft.permissionAtom(threadRef.environmentId));
  const saveDraft = useSaveQuestionDraft(threadRef);
  const writer = questionDraftWriter(scopedThreadKey(threadRef));
  const update = useAtomCommand(threadQuestionUpdate);
  // Local until the server returns them, so typing and choosing never wait on a round trip.
  const [pendingChoice, setPendingChoice] = useState<ReadonlyArray<string> | null>(null);
  const [pendingNotes, setPendingNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosenOptionIds = pendingChoice ?? question.answer?.chosenOptionIds ?? [];
  const notes = pendingNotes ?? question.answer?.notes ?? "";
  const answerable = question.state === "open" || question.state === "deferred";

  const edit = (change: Partial<QuestionDraft>, delayMs?: number) =>
    void writer
      .edit(
        question.id,
        {
          chosenOptionIds: question.answer?.chosenOptionIds ?? [],
          notes: question.answer?.notes ?? "",
        },
        change,
        saveDraft,
        delayMs,
      )
      .then(() => {
        // A later edit keeps its own pending value; this write only clears what it carried.
        setPendingChoice((current) => (current === change.chosenOptionIds ? null : current));
        setPendingNotes((current) => (current === change.notes ? null : current));
      });
  const changeState = async (state: "open" | "deferred" | "withdrawn") => {
    setBusy(true);
    await writer.flush(question.id, saveDraft);
    await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, id: question.id, state },
    });
    setBusy(false);
  };

  const headerAction = (label: string, state: "open" | "deferred" | "withdrawn") => (
    <Button
      size="xs"
      variant="outline"
      disabled={!canAct || busy}
      onClick={() => void changeState(state)}
    >
      {label}
    </Button>
  );
  const answerText = question.answer
    ? question.options
        .filter((option) => question.answer!.chosenOptionIds.includes(option.id))
        .map((option) => option.label)
        .join(", ")
    : "";

  return (
    <section
      id={inTimeline ? threadQuestionElementId(question.id) : undefined}
      aria-label={`${question.id}: ${question.prompt}`}
      className={cn(
        "@container min-w-0 space-y-3 rounded-lg border border-border border-l-2 bg-background p-3",
        question.state === "open" ? "border-l-primary" : "border-l-border",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            "text-sm font-semibold tabular-nums",
            answerable ? "text-primary" : "text-muted-foreground",
          )}
        >
          {question.id}
        </span>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{stateLabel(question)}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {actions}
          {question.state === "open" ? headerAction("Not yet", "deferred") : null}
          {question.state === "deferred" ||
          question.state === "answered" ||
          question.state === "withdrawn"
            ? headerAction("Reopen", "open")
            : null}
          {answerable ? headerAction("Dismiss", "withdrawn") : null}
          {question.state === "replaced" && question.replacedBy !== null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                requestQuestionReveal(scopedThreadKey(threadRef), question.replacedBy!)
              }
            >
              See {question.replacedBy}
            </Button>
          ) : null}
        </span>
      </header>
      <h3 className="text-sm font-medium leading-relaxed break-words">{question.prompt}</h3>
      {question.details ? (
        <div className="text-sm text-muted-foreground">
          <ChatMarkdown text={question.details} cwd={undefined} threadRef={threadRef} />
        </div>
      ) : null}
      {answerable ? (
        <>
          {question.options.length > 0 ? (
            <QuestionOptions
              question={question}
              chosenOptionIds={chosenOptionIds}
              disabled={!canAct}
              onChoose={(next) => {
                setPendingChoice(next);
                edit({ chosenOptionIds: next });
              }}
            />
          ) : null}
          <Textarea
            aria-label={`Note for ${question.id}`}
            size="sm"
            rows={1}
            placeholder={question.options.length > 0 ? "Add a note…" : "Your answer…"}
            value={notes}
            disabled={!canAct}
            onBlur={() => void writer.flush(question.id, saveDraft)}
            onChange={(event) => {
              setPendingNotes(event.target.value);
              edit({ notes: event.target.value }, NOTE_SAVE_DELAY_MS);
            }}
          />
        </>
      ) : question.state === "answered" && question.answer ? (
        <p className="text-sm break-words">
          {answerText ? <strong className="font-semibold">{answerText}</strong> : null}
          {answerText && question.answer.notes.trim() ? " · " : null}
          {question.answer.notes.trim() ? (
            <span className="text-muted-foreground">“{question.answer.notes.trim()}”</span>
          ) : null}
        </p>
      ) : question.state === "replaced" && question.replacedBy !== null ? (
        <p className="text-sm text-muted-foreground">
          The agent replaced this with {question.replacedBy}.
        </p>
      ) : null}
    </section>
  );
}
