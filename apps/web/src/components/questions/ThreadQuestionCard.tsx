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
import { QuestionOptions } from "./QuestionOptions";
import { QuestionStatusBadge } from "./QuestionStatusBadge";
import { questionAnswerForComposer } from "./questionComposer.logic";
import {
  addQuestionAnswersToComposer,
  removeQuestionAnswerFromComposer,
  useQuestionIdsInComposer,
} from "./questionComposer";
import { questionDraftWriter, type QuestionDraft } from "./questionDraftWriter";
import { requestQuestionReveal, threadQuestionElementId } from "./questionReveal";

const NOTE_SAVE_DELAY_MS = 600;

const HELP = {
  defer:
    "Set this aside. It leaves your count, and the agent may raise it again when the work needs it.",
  dismiss: "Close this without answering. The agent is told with your next message.",
  add: "Queue this answer to go with your next message.",
  addDisabled: "Choose an option or add a note first.",
  remove: "Take this answer out of your composer. Your draft stays here.",
  reopen: "Open this again so you can answer it.",
};

function HelpButton({
  help,
  children,
  ...props
}: {
  readonly help: string;
  readonly children: ReactNode;
} & Pick<Parameters<typeof Button>[0], "disabled" | "onClick" | "variant">) {
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

function AnswerText({ question }: { readonly question: ThreadQuestion }) {
  const answer = question.answer;
  if (answer === null) return null;
  const choice = question.options
    .filter((option) => answer.chosenOptionIds.includes(option.id))
    .map((option) => option.label)
    .join(", ");
  const note = answer.notes.trim();
  return (
    <p className="text-sm break-words">
      {choice ? <strong className="font-semibold">{choice}</strong> : null}
      {choice && note ? " · " : null}
      {note ? <span className="text-muted-foreground">“{note}”</span> : null}
    </p>
  );
}

/**
 * One agent question: answerable while open or deferred, its outcome once closed. Choosing an
 * option or typing a note saves a draft; Add to composer queues it for the user's next message.
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
  const inComposer = useQuestionIdsInComposer(threadRef).has(question.id);
  // Local until the server returns them, so typing and choosing never wait on a round trip.
  const [pendingChoice, setPendingChoice] = useState<ReadonlyArray<string> | null>(null);
  const [pendingNotes, setPendingNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosenOptionIds = pendingChoice ?? question.answer?.chosenOptionIds ?? [];
  const notes = pendingNotes ?? question.answer?.notes ?? "";
  const status = threadQuestionStatus(question, inComposer);
  const editable =
    (question.state === "open" || question.state === "deferred") && status !== "sent";
  const hasDraft = chosenOptionIds.length > 0 || notes.trim() !== "";

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
  const addToComposer = async () => {
    setBusy(true);
    // Notes still waiting or in flight are part of the answer the user means to queue.
    const flushed = await writer.flush(question.id, saveDraft);
    setBusy(false);
    const record = questionAnswerForComposer(threadRef.threadId, question, flushed);
    if (record !== null) addQuestionAnswersToComposer(threadRef, [record]);
    else if (flushed === null)
      toastManager.add({
        type: "error",
        title: `${question.id}'s answer did not save`,
        description: "Try again once the connection is back.",
      });
  };

  const stateButton = (label: string, help: string, state: "open" | "deferred" | "withdrawn") => (
    <HelpButton help={help} disabled={!canAct || busy} onClick={() => void changeState(state)}>
      {label}
    </HelpButton>
  );

  return (
    <section
      id={inTimeline ? threadQuestionElementId(question.id) : undefined}
      aria-label={`${question.id}: ${question.prompt}`}
      className={cn(
        "@container min-w-0 space-y-3 rounded-lg border border-border border-l-2 bg-background p-3",
        editable && question.state === "open" ? "border-l-primary" : "border-l-border",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            "text-sm font-semibold tabular-nums",
            editable ? "text-primary" : "text-muted-foreground",
          )}
        >
          {question.id}
        </span>
        <span className="min-w-0 flex-1">
          <QuestionStatusBadge status={status} />
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {actions}
          {editable && question.state === "open"
            ? stateButton("Not yet", HELP.defer, "deferred")
            : null}
          {question.state === "deferred" && editable
            ? stateButton("Reopen", HELP.reopen, "open")
            : null}
          {question.state === "answered" || question.state === "withdrawn"
            ? stateButton("Reopen", HELP.reopen, "open")
            : null}
          {editable ? stateButton("Dismiss", HELP.dismiss, "withdrawn") : null}
          {editable && inComposer ? (
            <HelpButton
              help={HELP.remove}
              onClick={() => removeQuestionAnswerFromComposer(threadRef, question.id)}
            >
              Remove from composer
            </HelpButton>
          ) : null}
          {editable && !inComposer ? (
            <HelpButton
              help={hasDraft ? HELP.add : HELP.addDisabled}
              variant="default"
              disabled={!canAct || busy || !hasDraft}
              onClick={() => void addToComposer()}
            >
              Add to composer
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
        </span>
      </header>
      <h3 className="text-sm font-medium leading-relaxed break-words">{question.prompt}</h3>
      {question.details ? (
        <div className="text-sm text-muted-foreground">
          <ChatMarkdown text={question.details} cwd={undefined} threadRef={threadRef} />
        </div>
      ) : null}
      {editable ? (
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
      ) : status === "sent" || question.state === "answered" ? (
        <AnswerText question={question} />
      ) : question.state === "replaced" && question.replacedBy !== null ? (
        <p className="text-sm text-muted-foreground">
          The agent replaced this with {question.replacedBy}.
        </p>
      ) : null}
    </section>
  );
}
