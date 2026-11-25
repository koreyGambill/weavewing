import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadQuestionStatus } from "@t3tools/client-runtime/state/thread-questions";
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
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { QuestionNoteBox } from "./QuestionNoteBox";
import { QuestionOptions } from "./QuestionOptions";
import { QuestionStatusBadge } from "./QuestionStatusBadge";
import { closedQuestionOutcome } from "./ThreadQuestionCard.logic";
import { questionAnswerForComposer } from "./questionComposer.logic";
import {
  addQuestionAnswersToComposer,
  removeQuestionAnswerFromComposer,
  useQuestionsInComposer,
} from "./questionComposer";
import { questionDraftWriter, type QuestionDraft } from "./questionDraftWriter";
import { requestQuestionReveal, threadQuestionElementId } from "./questionReveal";

const NOTE_SAVE_DELAY_MS = 600;

const HELP = {
  defer:
    "Set this aside. It leaves your count, and the agent may raise it again when the work needs it.",
  reopen: "Open this again so you can answer it.",
  dismiss: "Close this without answering. The agent is told with your next message.",
  discuss: "Put your note in the composer as a comment on this question. It stays open.",
  discussOff: "Take your comment out of the composer. Your note stays here.",
  discussDisabled: "Write a note first; Discuss sends the note, not your choice.",
  answer: "Queue this answer to go with your next message.",
  answerDisabled: "Choose an option or add a note first.",
  remove: "Take this answer out of your composer. Your draft stays here.",
  sent: "Sent. Edit or cancel the queued message to change it.",
};

function HelpButton({
  help,
  children,
  ...props
}: {
  readonly help: string;
  readonly children: ReactNode;
} & Pick<Parameters<typeof Button>[0], "disabled" | "onClick" | "variant" | "aria-pressed">) {
  return (
    <Tooltip>
      {/* A span keeps the hint reachable while the button is disabled. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button size="xs" variant="outline" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {help}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One agent question. While open or deferred: its options, one row each, and one box holding the
 * note and the four buttons, so nothing appears or moves as the user chooses. Once closed: one
 * line with the outcome, which expands to the full prompt.
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
  const inComposer = useQuestionsInComposer(threadRef).get(question.id);
  // Local until the server returns them, so typing and choosing never wait on a round trip.
  const [pendingChoice, setPendingChoice] = useState<ReadonlyArray<string> | null>(null);
  const [pendingNotes, setPendingNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const chosenOptionIds = pendingChoice ?? question.answer?.chosenOptionIds ?? [];
  const notes = pendingNotes ?? question.answer?.notes ?? "";
  const status = threadQuestionStatus(question, inComposer === "answer");
  const waiting = question.state === "open" || question.state === "deferred";
  const editable = waiting && status !== "sent";
  const usable = canAct && !busy && editable;
  const hasDraft = chosenOptionIds.length > 0 || notes.trim() !== "";
  const outcome = closedQuestionOutcome(question);

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
  const toComposer = async (kind: "answer" | "discuss") => {
    setBusy(true);
    // Notes still waiting or in flight are part of what the user means to queue.
    const flushed = await writer.flush(question.id, saveDraft);
    setBusy(false);
    const record = questionAnswerForComposer(threadRef.threadId, question, flushed, kind);
    if (record !== null) addQuestionAnswersToComposer(threadRef, [record]);
    else if (flushed === null)
      toastManager.add({
        type: "error",
        title: `${question.id}'s draft did not save`,
        description: "Try again once the connection is back.",
      });
  };

  if (outcome !== null) {
    const reopenable = question.state === "answered" || question.state === "withdrawn";
    return (
      <section
        id={inTimeline ? threadQuestionElementId(question.id) : undefined}
        aria-label={`${question.id}: ${question.prompt}`}
        className="@container min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5"
      >
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((open) => !open)}
                  className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              }
            >
              <span className="shrink-0 font-semibold tabular-nums text-muted-foreground">
                {question.id}
              </span>
              <span className={cn("min-w-0 flex-1", !expanded && "truncate")}>
                {question.prompt}
              </span>
              <span className={cn("max-w-[45%] shrink-0 font-semibold", !expanded && "truncate")}>
                {outcome}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96">
              <p>{question.prompt}</p>
              <p className="font-semibold">{outcome}</p>
            </TooltipPopup>
          </Tooltip>
          <QuestionStatusBadge status={status} />
          {actions}
          {reopenable ? (
            <HelpButton
              help={HELP.reopen}
              disabled={!canAct || busy}
              onClick={() => void changeState("open")}
            >
              Reopen
            </HelpButton>
          ) : null}
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
        </div>
        {expanded && question.details ? (
          <div className="pt-1.5 text-sm text-muted-foreground">
            <ChatMarkdown text={question.details} cwd={undefined} threadRef={threadRef} />
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section
      id={inTimeline ? threadQuestionElementId(question.id) : undefined}
      aria-label={`${question.id}: ${question.prompt}`}
      className={cn(
        "@container min-w-0 space-y-1.5 rounded-lg border border-border border-l-2 bg-background px-2.5 py-2",
        editable && question.state === "open" ? "border-l-primary" : "border-l-border",
      )}
    >
      <header className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "shrink-0 text-sm font-semibold tabular-nums",
            editable ? "text-primary" : "text-muted-foreground",
          )}
        >
          {question.id}
        </span>
        <h3 className="min-w-0 flex-1 text-sm font-medium leading-snug break-words">
          {question.prompt}
        </h3>
        {actions}
        <QuestionStatusBadge status={status} />
      </header>
      {question.details ? (
        <div className="text-sm text-muted-foreground">
          <ChatMarkdown text={question.details} cwd={undefined} threadRef={threadRef} />
        </div>
      ) : null}
      {question.options.length > 0 ? (
        <QuestionOptions
          question={question}
          chosenOptionIds={chosenOptionIds}
          disabled={!canAct || !editable}
          onChoose={(next) => {
            setPendingChoice(next);
            edit({ chosenOptionIds: next });
          }}
        />
      ) : null}
      <QuestionNoteBox
        text={notes || (question.options.length > 0 ? "Add a note…" : "Your answer…")}
        note={
          <Textarea
            unstyled
            size="sm"
            rows={1}
            aria-label={`Note for ${question.id}`}
            placeholder={question.options.length > 0 ? "Add a note…" : "Your answer…"}
            value={notes}
            disabled={!canAct || !editable}
            className="w-full"
            onBlur={() => void writer.flush(question.id, saveDraft)}
            onChange={(event) => {
              setPendingNotes(event.target.value);
              edit({ notes: event.target.value }, NOTE_SAVE_DELAY_MS);
            }}
          />
        }
        actions={
          <>
            {question.state === "deferred" ? (
              <HelpButton
                help={editable ? HELP.reopen : HELP.sent}
                disabled={!usable}
                onClick={() => void changeState("open")}
              >
                Reopen
              </HelpButton>
            ) : (
              <HelpButton
                help={editable ? HELP.defer : HELP.sent}
                disabled={!usable}
                onClick={() => void changeState("deferred")}
              >
                Not yet
              </HelpButton>
            )}
            <HelpButton
              help={editable ? HELP.dismiss : HELP.sent}
              disabled={!usable}
              onClick={() => void changeState("withdrawn")}
            >
              Dismiss
            </HelpButton>
            <HelpButton
              help={
                !editable
                  ? HELP.sent
                  : inComposer === "discuss"
                    ? HELP.discussOff
                    : notes.trim()
                      ? HELP.discuss
                      : HELP.discussDisabled
              }
              variant={inComposer === "discuss" ? "secondary" : "outline"}
              aria-pressed={inComposer === "discuss"}
              disabled={!usable || (inComposer !== "discuss" && notes.trim() === "")}
              onClick={() =>
                inComposer === "discuss"
                  ? removeQuestionAnswerFromComposer(threadRef, question.id)
                  : void toComposer("discuss")
              }
            >
              Discuss
            </HelpButton>
            <HelpButton
              help={
                !editable
                  ? HELP.sent
                  : inComposer === "answer"
                    ? HELP.remove
                    : hasDraft
                      ? HELP.answer
                      : HELP.answerDisabled
              }
              variant={inComposer === "answer" ? "outline" : "default"}
              disabled={!usable || (inComposer !== "answer" && !hasDraft)}
              onClick={() =>
                inComposer === "answer"
                  ? removeQuestionAnswerFromComposer(threadRef, question.id)
                  : void toComposer("answer")
              }
            >
              {/* Both labels share one cell, so the button keeps its width as they swap. */}
              <span className="grid">
                <span
                  className={cn("col-start-1 row-start-1", inComposer === "answer" && "invisible")}
                >
                  Answer
                </span>
                <span
                  className={cn("col-start-1 row-start-1", inComposer !== "answer" && "invisible")}
                >
                  Remove from composer
                </span>
              </span>
            </HelpButton>
          </>
        }
      />
    </section>
  );
}
