import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  threadQuestionHasDraft,
  threadQuestionStatus,
} from "@t3tools/client-runtime/state/thread-questions";
import type {
  ScopedThreadRef,
  ThreadWorkspace,
  TrackedAnswerWaitingRow,
  WaitingItemKind,
  WaitingItemSummary,
} from "@t3tools/contracts";
import { useState } from "react";
import { WaitingAnswerRows } from "../answers/WaitingAnswerRows";

import { cn } from "~/lib/utils";
import { evidenceSetQa } from "../../state/evidence";
import { threadTaskUpdate, useSaveQuestionDraft } from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { QaStatusBadge } from "../evidence/ThreadQaCard";
import { TaskStatusBadge } from "../tasks/TaskStatusBadge";
import {
  addQuestionAnswersToComposer,
  removeQuestionAnswerFromComposer,
  useQuestionsInComposer,
} from "../questions/questionComposer";
import { questionAnswerForComposer } from "@t3tools/client-runtime/state/thread-question-composer";
import { questionDraftWriter } from "../questions/questionDraftWriter";
import {
  revealQuestionInChat,
  revealQaInChat,
  revealTaskInChat,
} from "../questions/questionReveal";
import { QuestionStatusBadge } from "../questions/QuestionStatusBadge";
import { HelpButton } from "../questions/ThreadCardShell";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { removeWaitingItemDiscuss, useWaitingItemsInComposer } from "./waitingItemComposer";
import { WAITING_KIND_ICON } from "./waitingKindIcon";
import { WAITING_KIND_HEADING, qaKeyParts } from "./waitingStrip.logic";

/**
 * Moves focus from a row the user just settled to the next row's title, or the previous one's,
 * or the list itself, so the keyboard stays in the list when the row leaves it.
 */
function keepFocusInList(from: HTMLElement | null) {
  const row = from?.closest<HTMLElement>("[data-waiting-row]");
  const list = row?.closest<HTMLElement>('[role="group"]');
  if (!row || !list) return;
  const rows = [...list.querySelectorAll<HTMLElement>("[data-waiting-row]")];
  const index = rows.indexOf(row);
  const neighbour = rows[index + 1] ?? rows[index - 1];
  (neighbour?.querySelector<HTMLElement>("button") ?? list).focus({ preventScroll: true });
}

// Module-level, so React calls it once as the list opens and never refocuses it on a render.
// Opening the list hands it the keyboard, so Tab walks its rows.
const focusOnOpen = (element: HTMLDivElement | null) => element?.focus({ preventScroll: true });

/**
 * The waiting items above the composer, grouped by kind. A row's title shows its card in the
 * chat, or the Checklist view for a task; its button is that kind's one-click answer. Under 600 px
 * a row keeps only its title and answer.
 */
export function WaitingItemsList({
  threadRef,
  groups,
  workspace,
  unlisted,
  hasQuestions,
  answerRows,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly groups: ReadonlyArray<{
    readonly kind: WaitingItemKind;
    readonly items: ReadonlyArray<WaitingItemSummary>;
  }>;
  readonly workspace: ThreadWorkspace | null;
  /** Items still waiting that the capped rows leave out. */
  readonly unlisted: number;
  readonly hasQuestions: boolean;
  readonly answerRows?: ReadonlyArray<TrackedAnswerWaitingRow> | undefined;
}) {
  const sidebar = useThreadContextSidebarStore.getState;
  return (
    <div
      role="group"
      aria-label="Waiting on you"
      tabIndex={-1}
      ref={focusOnOpen}
      className="@container max-h-[min(18rem,40vh)] space-y-1.5 overflow-y-auto rounded-md outline-none"
    >
      {groups.map((group) => (
        <section key={group.kind} aria-label={WAITING_KIND_HEADING[group.kind]}>
          <h4 className="px-2 pb-0.5 text-xs font-medium text-muted-foreground">
            {WAITING_KIND_HEADING[group.kind]}
          </h4>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <WaitingItemRow
                key={`${item.kind}:${item.key}`}
                threadRef={threadRef}
                item={item}
                workspace={workspace}
              />
            ))}
          </ul>
        </section>
      ))}
      {answerRows?.length ? <WaitingAnswerRows threadRef={threadRef} rows={answerRows} /> : null}
      {unlisted > 0 ? (
        <p className="flex flex-wrap items-center gap-x-1 px-2 pb-1 text-xs text-muted-foreground">
          <span>{unlisted} more not listed here. See them in</span>
          {hasQuestions ? (
            <Button
              variant="link"
              size="micro"
              onClick={() => useRightPanelStore.getState().open(threadRef, "questions", "tile-2")}
            >
              Questions
            </Button>
          ) : null}
          <Button
            variant="link"
            size="micro"
            onClick={() => sidebar().show("evidence", { thread: threadRef })}
          >
            Evidence
          </Button>
          <Button
            variant="link"
            size="micro"
            onClick={() => sidebar().show("checklist", { thread: threadRef })}
          >
            Checklist
          </Button>
        </p>
      ) : null}
    </div>
  );
}

function WaitingItemRow({
  threadRef,
  item,
  workspace,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly item: WaitingItemSummary;
  readonly workspace: ThreadWorkspace | null;
}) {
  const Icon = WAITING_KIND_ICON[item.kind];
  const threadKey = scopedThreadKey(threadRef);
  const show = () => {
    if (item.kind === "question") revealQuestionInChat(threadKey, item.key);
    else if (item.kind === "qa") revealQaInChat(threadKey, item);
    else
      revealTaskInChat(threadKey, item.ref, () =>
        useThreadContextSidebarStore.getState().show("checklist", { thread: threadRef }),
      );
  };
  return (
    <li
      data-waiting-row
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <button
        type="button"
        onClick={show}
        aria-label={`${item.ref}: ${item.title}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span
          className={cn(
            "shrink-0 font-semibold tabular-nums",
            item.state === "open" ? "text-primary" : "text-muted-foreground",
          )}
        >
          {item.ref}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
      </button>
      {item.kind === "question" ? (
        <QuestionRowControls threadRef={threadRef} item={item} workspace={workspace} />
      ) : item.kind === "qa" ? (
        <QaRowControls threadRef={threadRef} item={item} />
      ) : (
        <TaskRowControls threadRef={threadRef} item={item} workspace={workspace} />
      )}
    </li>
  );
}

const badgeSlot = "hidden shrink-0 @[600px]:inline-flex";

function QuestionRowControls({
  threadRef,
  item,
  workspace,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly item: WaitingItemSummary;
  readonly workspace: ThreadWorkspace | null;
}) {
  const inComposer = useQuestionsInComposer(threadRef).get(item.key);
  const discussing = useWaitingItemsInComposer(threadRef, "question").has(item.key);
  const saveDraft = useSaveQuestionDraft(threadRef);
  const [busy, setBusy] = useState(false);
  const question = workspace?.questions.find((entry) => entry.id === item.key);
  const hasDraft = question !== undefined && threadQuestionHasDraft(question);
  const answer = async () => {
    if (question === undefined || workspace === null) return;
    setBusy(true);
    const flushed = await questionDraftWriter(scopedThreadKey(threadRef)).flush(
      question.id,
      saveDraft,
    );
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
  return (
    <>
      {question === undefined ? null : (
        <span className={badgeSlot}>
          <QuestionStatusBadge
            status={threadQuestionStatus(
              question,
              inComposer === "answer" ? "answer" : discussing ? "discuss" : undefined,
            )}
          />
        </span>
      )}
      <HelpButton
        help={
          inComposer === "answer"
            ? "Take this answer out of the composer."
            : hasDraft
              ? "Put your drafted answer in the composer. It goes with your next message."
              : "Choose an option or write a note on the card first."
        }
        variant={inComposer !== "answer" && hasDraft && !busy ? "default" : "contrast-outline"}
        disabled={busy || (inComposer !== "answer" && !hasDraft)}
        aria-label={`${inComposer === "answer" ? "Cancel the answer to" : "Answer"} ${item.ref}`}
        onClick={() =>
          inComposer === "answer"
            ? removeQuestionAnswerFromComposer(threadRef, item.key)
            : void answer()
        }
      >
        {inComposer === "answer" ? "Cancel" : "Answer"}
      </HelpButton>
    </>
  );
}

function QaRowControls({
  threadRef,
  item,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly item: WaitingItemSummary;
}) {
  const canAct = useAtomValue(evidenceSetQa.permissionAtom(threadRef.environmentId));
  const setQa = useAtomCommand(evidenceSetQa, { label: "QA" });
  const inComposer = useWaitingItemsInComposer(threadRef, "qa").has(item.key);
  const [busy, setBusy] = useState(false);
  const parts = qaKeyParts(item.key);
  const fixing = item.state === "problem";
  const confirm = async (from: HTMLElement) => {
    if (parts === null) return;
    setBusy(true);
    const result = await setQa({
      environmentId: threadRef.environmentId,
      input: { ...parts, state: "confirmed" },
    });
    setBusy(false);
    if (result._tag !== "Success") return;
    removeWaitingItemDiscuss(threadRef, "qa", item.key);
    keepFocusInList(from);
  };
  return (
    <>
      <span className={badgeSlot}>
        <QaStatusBadge
          status={
            fixing
              ? "agent-fixing"
              : inComposer
                ? "in-composer"
                : item.state === "discussing"
                  ? "discussing"
                  : "open"
          }
          note=""
        />
      </span>
      <HelpButton
        help={
          fixing
            ? "The agent owes a fix; a later landing closes this."
            : "You checked it and it works. Nothing is sent to the agent."
        }
        variant={canAct && !busy && !fixing ? "default" : "contrast-outline"}
        disabled={!canAct || busy || fixing || parts === null}
        aria-label={`Looks good: ${item.ref}`}
        onClick={(event) => void confirm(event.currentTarget)}
      >
        Looks good
      </HelpButton>
    </>
  );
}

function TaskRowControls({
  threadRef,
  item,
  workspace,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly item: WaitingItemSummary;
  readonly workspace: ThreadWorkspace | null;
}) {
  const canAct = useAtomValue(threadTaskUpdate.permissionAtom(threadRef.environmentId));
  const update = useAtomCommand(threadTaskUpdate, { label: "Task" });
  const inComposer = useWaitingItemsInComposer(threadRef, "task").has(item.key);
  const [busy, setBusy] = useState(false);
  const done = async (from: HTMLElement) => {
    if (workspace === null) return;
    setBusy(true);
    const result = await update({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        expectedRevision: workspace.revision,
        changes: [{ id: item.key, state: "done" }],
      },
    });
    setBusy(false);
    if (result._tag !== "Success") return;
    removeWaitingItemDiscuss(threadRef, "task", item.key);
    keepFocusInList(from);
  };
  const usable = canAct && !busy && workspace !== null;
  return (
    <>
      <span className={badgeSlot}>
        <TaskStatusBadge
          status={inComposer ? "in-composer" : item.state === "discussing" ? "discussing" : "open"}
          note=""
        />
      </span>
      <HelpButton
        help="You did it. Nothing is sent to the agent."
        variant={usable ? "default" : "contrast-outline"}
        disabled={!usable}
        aria-label={`Done: ${item.ref}`}
        onClick={(event) => void done(event.currentTarget)}
      >
        Done
      </HelpButton>
    </>
  );
}
