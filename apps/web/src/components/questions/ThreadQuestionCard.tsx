import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadQuestionStatus } from "@t3tools/client-runtime/state/thread-questions";
import type { ScopedThreadRef, ThreadQuestion } from "@t3tools/contracts";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
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
import { closedQuestionOutcome, closedQuestionShownAnswer } from "./ThreadQuestionCard.logic";
import { questionAnswerForComposer } from "./questionComposer.logic";
import {
  addQuestionAnswersToComposer,
  removeQuestionAnswerFromComposer,
  useQuestionsInComposer,
} from "./questionComposer";
import { questionDraftWriter, type QuestionDraft } from "./questionDraftWriter";
import { revealQuestionInChat, threadQuestionElementId } from "./questionReveal";

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
  cancel: "Take this answer out of your message. Your choice stays on the card.",
  sent: "Sent. Edit or cancel the queued message to change it.",
};

function HelpButton({
  help,
  children,
  variant = "contrast-outline",
  ...props
}: {
  readonly help: string;
  readonly children: ReactNode;
} & Pick<Parameters<typeof Button>[0], "disabled" | "onClick" | "variant" | "aria-pressed">) {
  return (
    <Tooltip>
      {/* A span keeps the hint reachable while the button is disabled. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button size="xs" variant={variant} {...props}>
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
 * line with the outcome, which expands to the same card, read-only.
 */
export function ThreadQuestionCard({
  question,
  threadRef,
  actions,
  inTimeline = false,
  replaces = null,
  onReveal,
}: {
  readonly question: ThreadQuestion;
  readonly threadRef: ScopedThreadRef;
  /** Extra header controls, such as the panel's Show in chat. */
  readonly actions?: ReactNode;
  readonly inTimeline?: boolean;
  /** The question this one replaced, linked from its header. */
  readonly replaces?: string | null;
  /** Shows another question's card; the chat's by default. */
  readonly onReveal?: (questionId: string) => void;
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
  const [descriptionsCollapsed, setDescriptionsCollapsed] = useState(false);
  const chosenOptionIds = pendingChoice ?? question.answer?.chosenOptionIds ?? [];
  const notes = pendingNotes ?? question.answer?.notes ?? "";
  const status = threadQuestionStatus(question, inComposer);
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

  const closed = outcome !== null;
  const reopenable = question.state === "answered" || question.state === "withdrawn";
  const reopen = () => {
    setExpanded(false);
    void changeState("open");
  };
  const reopenButton = reopenable ? (
    <HelpButton help={HELP.reopen} disabled={!canAct || busy} onClick={reopen}>
      Reopen
    </HelpButton>
  ) : null;
  const reveal = onReveal ?? ((id: string) => revealQuestionInChat(scopedThreadKey(threadRef), id));
  const questionLink = (id: string, label: string, help: string) => (
    <HelpButton help={help} onClick={() => reveal(id)}>
      {label}
    </HelpButton>
  );
  // A replaced question links to its replacement where its badge would be, so it says it once.
  const statusControl =
    question.state === "replaced" && question.replacedBy !== null ? (
      questionLink(
        question.replacedBy,
        `Replaced by ${question.replacedBy}`,
        `The agent asked this again as ${question.replacedBy}. Show it.`,
      )
    ) : (
      <QuestionStatusBadge status={status} />
    );

  if (closed && !expanded) {
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
                  aria-expanded={false}
                  onClick={() => setExpanded(true)}
                  className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              }
            >
              <span className="shrink-0 font-semibold tabular-nums text-muted-foreground">
                {question.id}
              </span>
              <span className="min-w-0 flex-1 truncate">{question.prompt}</span>
              {outcome ? (
                <span className="max-w-[45%] shrink-0 truncate font-semibold">{outcome}</span>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96">
              <p>{question.prompt}</p>
              {outcome ? <p className="font-semibold">{outcome}</p> : null}
            </TooltipPopup>
          </Tooltip>
          {statusControl}
          {actions}
          {reopenButton}
        </div>
      </section>
    );
  }

  // An expanded closed card keeps the open card's layout, read-only, so it can be inspected whole.
  const shown = closed ? closedQuestionShownAnswer(question) : { chosenOptionIds, notes };
  const heading = (
    <>
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
    </>
  );

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
        {closed ? (
          <button
            type="button"
            aria-expanded
            onClick={() => setExpanded(false)}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {heading}
          </button>
        ) : (
          heading
        )}
        {actions}
        {replaces === null
          ? null
          : questionLink(replaces, `Replaces ${replaces}`, `This replaces ${replaces}. Show it.`)}
        {statusControl}
        {question.options.some((option) => option.description) ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="contrast-outline"
                  aria-label={
                    descriptionsCollapsed
                      ? "Expand option descriptions"
                      : "Collapse option descriptions"
                  }
                  onClick={() => setDescriptionsCollapsed((current) => !current)}
                />
              }
            >
              {descriptionsCollapsed ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {descriptionsCollapsed
                ? "Expand option descriptions"
                : "Collapse option descriptions"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </header>
      {question.details ? (
        <div className="text-sm text-muted-foreground">
          <ChatMarkdown text={question.details} cwd={undefined} threadRef={threadRef} />
        </div>
      ) : null}
      {question.options.length > 0 ? (
        <QuestionOptions
          question={question}
          chosenOptionIds={shown.chosenOptionIds}
          disabled={closed || !canAct || !editable}
          collapsed={descriptionsCollapsed}
          onChoose={(next) => {
            setPendingChoice(next);
            edit({ chosenOptionIds: next });
          }}
        />
      ) : null}
      {closed ? (
        <QuestionNoteBox
          text={shown.notes || "No note"}
          note={
            <p
              className={cn(
                "w-full px-2.5 py-1 text-sm whitespace-pre-wrap wrap-anywhere",
                !shown.notes && "text-muted-foreground",
              )}
            >
              {shown.notes || "No note"}
            </p>
          }
          actions={reopenButton}
        />
      ) : (
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
                      ? HELP.cancel
                      : hasDraft
                        ? HELP.answer
                        : HELP.answerDisabled
                }
                // A disabled primary button still reads as live, so Answer is primary only when usable.
                variant={
                  inComposer !== "answer" && usable && hasDraft ? "default" : "contrast-outline"
                }
                disabled={!usable || (inComposer !== "answer" && !hasDraft)}
                onClick={() =>
                  inComposer === "answer"
                    ? removeQuestionAnswerFromComposer(threadRef, question.id)
                    : void toComposer("answer")
                }
              >
                {inComposer === "answer" ? "Cancel" : "Answer"}
              </HelpButton>
            </>
          }
        />
      )}
    </section>
  );
}
