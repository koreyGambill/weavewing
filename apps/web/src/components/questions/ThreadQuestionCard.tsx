import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  threadQuestionImageMarker,
  threadQuestionImageMarkerNumbers,
  threadQuestionImageNumber,
  threadQuestionImagesWithoutMarkers,
  threadQuestionStatus,
  withoutThreadQuestionImageMarkers,
} from "@t3tools/client-runtime/state/thread-questions";
import { threadQuestionTitle, type ScopedThreadRef, type ThreadQuestion } from "@t3tools/contracts";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
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
import { ComposerImageThumbnail } from "../chat/ComposerImageThumbnail";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { QuestionNoteBox } from "./QuestionNoteBox";
import { QuestionOptions } from "./QuestionOptions";
import { QuestionStatusBadge } from "./QuestionStatusBadge";
import { HelpButton, ThreadCard, ThreadCardClosedLine, ThreadCardHeading } from "./ThreadCardShell";
import {
  closedQuestionOutcome,
  closedQuestionShownAnswer,
} from "@t3tools/client-runtime/state/thread-question-card";
import { questionAnswerForComposer } from "@t3tools/client-runtime/state/thread-question-composer";
import {
  addQuestionAnswersToComposer,
  removeQuestionAnswerFromComposer,
  useQuestionsInComposer,
} from "./questionComposer";
import { questionDraftWriter, type QuestionDraft } from "./questionDraftWriter";
import {
  dropQuestionNoteImages,
  holdQuestionNoteImages,
  transferHasImage,
  useQuestionNoteImages,
} from "./questionNoteImages";
import { revealQuestionInChat, threadQuestionElementId } from "./questionReveal";
import {
  removeWaitingItemDiscuss,
  toggleWaitingItemDiscuss,
  useWaitingItemsInComposer,
  waitingItemDiscussRecord,
} from "../waiting/waitingItemComposer";

const NOTE_SAVE_DELAY_MS = 600;

const HELP = {
  defer:
    "Set this aside. It leaves your count, and the agent may raise it again when the work needs it.",
  reopen: "Open this again so you can answer it.",
  dismiss: "Close this without answering. The agent is told with your next message.",
  discuss:
    "Put a reference to this question in the composer and write about it there. It stays open.",
  discussOff: "Take the reference to this question out of the composer.",
  answer: "Queue this answer to go with your next message.",
  answerDisabled: "Choose an option or add a note first.",
  cancel: "Take this answer out of your message. Your choice stays on the card.",
  sent: "Sent. Edit or cancel the queued message to change it.",
};

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
  // The composer holds this question's answer, or a Discuss reference to it, or both.
  const answerInComposer = useQuestionsInComposer(threadRef).get(question.id) === "answer";
  const discussing = useWaitingItemsInComposer(threadRef, "question").has(question.id);
  // Local until the server returns them, so typing and choosing never wait on a round trip.
  const [pendingChoice, setPendingChoice] = useState<ReadonlyArray<string> | null>(null);
  const [pendingNotes, setPendingNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [descriptionsCollapsed, setDescriptionsCollapsed] = useState(false);
  const chosenOptionIds = pendingChoice ?? question.answer?.chosenOptionIds ?? [];
  const notes = pendingNotes ?? question.answer?.notes ?? "";
  const status = threadQuestionStatus(
    question,
    answerInComposer ? "answer" : discussing ? "discuss" : undefined,
  );
  const waiting = question.state === "open" || question.state === "deferred";
  const editable = waiting && status !== "sent";
  const usable = canAct && !busy && editable;
  const hasDraft = chosenOptionIds.length > 0 || notes.trim() !== "";
  const outcome = closedQuestionOutcome(question);
  const heldImages = useQuestionNoteImages(threadRef, question.id);
  // An image whose marker left the note, such as a comment the agent took, no longer shows.
  const markedNumbers = threadQuestionImageMarkerNumbers(question.id, notes);
  const noteImages = heldImages.flatMap((image) => {
    const number = threadQuestionImageNumber(question.id, image.name);
    return number !== null && markedNumbers.has(number)
      ? [{ image, number, marker: threadQuestionImageMarker(question.id, number) }]
      : [];
  });

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
  const changeNotes = (next: string, delayMs?: number) => {
    setPendingNotes(next);
    edit({ notes: next }, delayMs);
    dropQuestionNoteImages(
      threadRef,
      question.id,
      threadQuestionImagesWithoutMarkers(question.id, heldImages, next),
    );
  };
  const attachImages = async (field: HTMLTextAreaElement, files: ReadonlyArray<File>) => {
    const before = field.value;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const { error } = await holdQuestionNoteImages({
      threadRef,
      questionId: question.id,
      files,
      note: () => field.value,
      // In the same step that holds the images, so nothing sees an image without its marker.
      onHeld: (markers) => {
        const current = field.value;
        // At the caret when the note did not change meanwhile; otherwise after it.
        const [head, tail] =
          current === before ? [current.slice(0, start), current.slice(end)] : [current, ""];
        const lead = head === "" || /\s$/.test(head) ? "" : " ";
        changeNotes(`${head}${lead}${markers.join(" ")}${tail}`);
      },
    });
    if (error !== null) toastManager.add({ type: "error", title: error });
  };
  const removeImage = (imageId: string, number: number) => {
    dropQuestionNoteImages(threadRef, question.id, [imageId]);
    changeNotes(withoutThreadQuestionImageMarkers(question.id, notes, new Set([number])));
  };
  const changeState = async (state: "open" | "deferred" | "withdrawn") => {
    if (state === "withdrawn") removeWaitingItemDiscuss(threadRef, "question", question.id);
    setBusy(true);
    await writer.flush(question.id, saveDraft);
    await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, id: question.id, state },
    });
    setBusy(false);
  };
  const toComposer = async () => {
    setBusy(true);
    // Notes still waiting or in flight are part of what the user means to queue.
    const flushed = await writer.flush(question.id, saveDraft);
    setBusy(false);
    const record = questionAnswerForComposer(threadRef.threadId, question, flushed);
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
  const replacesLink =
    replaces === null
      ? null
      : questionLink(replaces, `Replaces ${replaces}`, `This replaces ${replaces}. Show it.`);
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
      <ThreadCardClosedLine
        id={inTimeline ? threadQuestionElementId(question.id) : undefined}
        label={`${question.id}: ${question.prompt}`}
        refLabel={question.id}
        title={question.prompt}
        outcome={outcome}
        onExpand={() => setExpanded(true)}
      >
        {replacesLink}
        {statusControl}
        {actions}
        {reopenButton}
      </ThreadCardClosedLine>
    );
  }

  // An expanded closed card keeps the open card's layout, read-only, so it can be inspected whole.
  const shown = closed ? closedQuestionShownAnswer(question) : { chosenOptionIds, notes };
  return (
    <ThreadCard
      id={inTimeline ? threadQuestionElementId(question.id) : undefined}
      label={`${question.id}: ${question.prompt}`}
      waiting={editable && question.state === "open"}
      heading={
        <ThreadCardHeading refLabel={question.id} title={question.prompt} editable={editable} />
      }
      onCollapse={closed ? () => setExpanded(false) : undefined}
      controls={
        <>
          {actions}
          {replacesLink}
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
        </>
      }
    >
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
              onChange={(event) => changeNotes(event.target.value, NOTE_SAVE_DELAY_MS)}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (!transferHasImage(files)) return;
                event.preventDefault();
                void attachImages(event.currentTarget, files);
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) event.preventDefault();
              }}
              onDrop={(event) => {
                const files = [...event.dataTransfer.files];
                if (!transferHasImage(files)) return;
                // The chat's own drop target would put the image straight in the composer.
                event.preventDefault();
                event.stopPropagation();
                void attachImages(event.currentTarget, files);
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
                help={!editable ? HELP.sent : discussing ? HELP.discussOff : HELP.discuss}
                aria-label={`Discuss ${question.id}`}
                aria-pressed={discussing}
                disabled={!canAct || !editable}
                onClick={(event) =>
                  toggleWaitingItemDiscuss(
                    threadRef,
                    waitingItemDiscussRecord({
                      itemKind: "question",
                      key: question.id,
                      ref: question.id,
                      title: threadQuestionTitle(question.prompt),
                    }),
                    event.currentTarget,
                  )
                }
              >
                Discuss
              </HelpButton>
              <HelpButton
                help={
                  !editable
                    ? HELP.sent
                    : answerInComposer
                      ? HELP.cancel
                      : hasDraft
                        ? HELP.answer
                        : HELP.answerDisabled
                }
                // A disabled primary button still reads as live, so Answer is primary only when usable.
                variant={!answerInComposer && usable && hasDraft ? "default" : "contrast-outline"}
                disabled={!usable || (!answerInComposer && !hasDraft)}
                onClick={() =>
                  answerInComposer
                    ? removeQuestionAnswerFromComposer(threadRef, question.id)
                    : void toComposer()
                }
              >
                {answerInComposer ? "Cancel" : "Answer"}
              </HelpButton>
            </>
          }
        />
      )}
      {!closed && noteImages.length > 0 ? (
        <ul aria-label={`Images for ${question.id}`} className="flex flex-wrap gap-1.5">
          {noteImages.map(({ image, number, marker }) => (
            <li
              key={image.id}
              className="flex items-start gap-1 rounded-md border border-foreground/30 p-0.5"
            >
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <ComposerImageThumbnail
                    file={image.file}
                    alt={marker}
                    className="h-10 w-auto max-w-24 rounded-sm object-contain"
                    fallback={<span className="block size-10 rounded-sm bg-muted" />}
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">{marker}</TooltipPopup>
              </Tooltip>
              {editable ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="contrast-outline"
                        aria-label={`Remove ${marker}`}
                        disabled={!usable}
                        onClick={() => removeImage(image.id, number)}
                      />
                    }
                  >
                    <XIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    Remove {marker} from this note and your message
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </ThreadCard>
  );
}
