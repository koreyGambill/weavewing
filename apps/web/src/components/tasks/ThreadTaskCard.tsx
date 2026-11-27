import { useAtomValue } from "@effect/atom-react";
import { LIST_ITEM_NOTE_MAX_LENGTH, type ListItem, type ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useRef, useState } from "react";

import { threadTaskUpdate } from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { threadTaskElementId } from "../questions/questionReveal";
import {
  CardReasonForm,
  HelpButton,
  NextReferenceButton,
  ThreadCard,
  ThreadCardClosedLine,
  ThreadCardHeading,
} from "../questions/ThreadCardShell";
import {
  removeWaitingItemDiscuss,
  toggleWaitingItemDiscuss,
  useWaitingItemsInComposer,
  waitingItemDiscussRecord,
} from "../waiting/waitingItemComposer";
import { taskCardOutcome, taskCardStatus } from "./taskCard.logic";
import { TaskStatusBadge } from "./TaskStatusBadge";

const HELP = {
  dismiss: "Cancel this task. Nothing is sent to the agent; it hears with your next message.",
  discuss: "Put a reference to this task in the composer and write about it there.",
  discussOff: "Take the reference to this task out of the composer.",
  done: "You did it. Nothing is sent to the agent; it hears with your next message.",
  reopen: "Open this again. Nothing is sent to the agent.",
  reason:
    "Say why you dismissed it. It is saved with the task; the agent sees it when it reads the list.",
};

/** One read-only row: a muted label column, then the content, with the option rows' padding. */
function TaskRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-sm @min-[28rem]:flex-row @min-[28rem]:gap-2">
      <span className="w-18 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * One task only the user can do, where the agent filed it: the question card's shell with the
 * task's details and links, and Dismiss, Discuss and Done. Closed, one line that expands.
 */
export function ThreadTaskCard({
  threadRef,
  task,
  revision,
  inTimeline = false,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly task: ListItem & { readonly ref: string };
  /** The workspace revision `task` was read at, which a write must match. */
  readonly revision: number;
  readonly inTimeline?: boolean;
}) {
  const canAct = useAtomValue(threadTaskUpdate.permissionAtom(threadRef.environmentId));
  const update = useAtomCommand(threadTaskUpdate, { label: "Task" });
  const inComposer = useWaitingItemsInComposer(threadRef, "task").has(task.id);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Where focus goes once the card changes shape under the button that was pressed.
  const focusNext = useRef<"line" | "card" | "reason" | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const status = taskCardStatus(task, inComposer);
  const waiting = task.state === "open";
  const usable = canAct && !busy;
  const label = `${task.ref}: ${task.text}`;
  const note = task.note?.trim() ?? "";
  const outcome = taskCardOutcome(task);
  const record = () =>
    waitingItemDiscussRecord({ itemKind: "task", key: task.id, ref: task.ref, title: task.text });

  const write = async (change: {
    readonly state?: "open" | "done" | "dropped";
    readonly note?: string;
  }) => {
    setBusy(true);
    const result = await update({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        expectedRevision: revision,
        changes: [{ id: task.id, ...change }],
      },
    });
    setBusy(false);
    return result._tag === "Success";
  };
  const setState = (state: "open" | "done" | "dropped") => write({ state });
  const settle = async (state: "done" | "dropped") => {
    focusNext.current = "line";
    // Only once the server took it: a refused write leaves the task open with its draft intact.
    if (await setState(state)) removeWaitingItemDiscuss(threadRef, "task", task.id);
    else focusNext.current = null;
    setExpanded(false);
  };
  const reopen = async () => {
    focusNext.current = "card";
    setExpanded(false);
    if (!(await setState("open"))) focusNext.current = null;
  };
  // The reason form replaces the button that opened it, so closing it hands focus back there.
  const closeReason = () => {
    focusNext.current = "reason";
    setReason(null);
  };
  const saveReason = async () => {
    if (reason === null) return;
    if (reason.trim() !== note && !(await write({ note: reason.trim() }))) return;
    closeReason();
  };
  // The task can change before the write returns, so a button mounted while busy waits until enabled.
  const focusOnMount = (target: "line" | "card" | "reason") => (node: HTMLButtonElement | null) => {
    if (node === null || node.disabled || focusNext.current !== target) return;
    focusNext.current = null;
    node.focus();
  };
  const id = inTimeline ? threadTaskElementId(task.ref) : undefined;
  const reopenButton = (
    <HelpButton
      help={HELP.reopen}
      aria-label={`Reopen ${task.ref}`}
      disabled={!usable}
      onClick={() => void reopen()}
    >
      Reopen
    </HelpButton>
  );

  const nextReference = (
    <NextReferenceButton
      item={{ kind: "task", taskId: task.id }}
      refLabel={task.ref}
      pointers={[task.settledFromMessageId, task.discussedInMessageId]}
    />
  );

  if (!waiting && !expanded) {
    return (
      <ThreadCardClosedLine
        id={id}
        label={label}
        refLabel={task.ref}
        title={task.text}
        outcome={outcome}
        hint={note ? <p className="whitespace-pre-wrap">{note}</p> : undefined}
        expandRef={focusOnMount("line")}
        onExpand={() => setExpanded(true)}
        stackOnNarrow
      >
        <TaskStatusBadge status={status} note={note} />
        {nextReference}
        {reopenButton}
      </ThreadCardClosedLine>
    );
  }

  const userDismissed = task.state === "dropped" && task.settledBy !== "agent";
  const linkLabels = task.links.map(
    (link) => task.linkStates?.find((state) => state.target === link.target)?.label ?? link.target,
  );
  const noteLabel = task.settledBy === "agent" ? "Agent's note" : "Your note";

  return (
    <ThreadCard
      id={id}
      label={label}
      waiting={waiting}
      heading={<ThreadCardHeading refLabel={task.ref} title={task.text} editable={waiting} />}
      onCollapse={waiting ? undefined : () => setExpanded(false)}
      controls={
        <>
          <TaskStatusBadge status={status} note={note} />
          {nextReference}
        </>
      }
    >
      {task.details.trim() || linkLabels.length > 0 || (!waiting && note) ? (
        <div className="space-y-0.5">
          {task.details.trim() ? (
            <TaskRow label="Details">
              <div className="text-muted-foreground">
                <ChatMarkdown text={task.details} cwd={undefined} threadRef={threadRef} />
              </div>
            </TaskRow>
          ) : null}
          {linkLabels.length > 0 ? (
            <TaskRow label="Links">
              <span className="break-words">{linkLabels.join(", ")}</span>
            </TaskRow>
          ) : null}
          {!waiting && note ? (
            <TaskRow label={noteLabel}>
              <span className="whitespace-pre-wrap break-words">{note}</span>
            </TaskRow>
          ) : null}
        </div>
      ) : null}
      {reason !== null ? (
        <CardReasonForm
          label={`Why ${task.ref} was dismissed`}
          value={reason}
          maxLength={LIST_ITEM_NOTE_MAX_LENGTH}
          disabled={!usable}
          onChange={setReason}
          onCancel={closeReason}
          onSave={() => void saveReason()}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {waiting ? (
            <>
              <HelpButton
                help={HELP.dismiss}
                aria-label={`Dismiss ${task.ref}`}
                disabled={!usable}
                onClick={() => void settle("dropped")}
              >
                Dismiss
              </HelpButton>
              <HelpButton
                help={inComposer ? HELP.discussOff : HELP.discuss}
                aria-label={`Discuss ${task.ref}`}
                aria-pressed={inComposer}
                disabled={!canAct}
                onClick={(event) =>
                  toggleWaitingItemDiscuss(threadRef, record(), event.currentTarget)
                }
              >
                Discuss
              </HelpButton>
              <HelpButton
                help={HELP.done}
                aria-label={`Done: ${task.ref}`}
                // A disabled primary button still reads as live, so it is primary only when usable.
                variant={usable ? "default" : "contrast-outline"}
                ref={focusOnMount("card")}
                disabled={!usable}
                onClick={() => void settle("done")}
              >
                Done
              </HelpButton>
            </>
          ) : (
            <>
              {userDismissed ? (
                <HelpButton
                  help={HELP.reason}
                  aria-label={`${note ? "Edit" : "Add"} why ${task.ref} was dismissed`}
                  ref={focusOnMount("reason")}
                  disabled={!usable}
                  onClick={() => setReason(task.note ?? "")}
                >
                  {note ? "Edit reason" : "Add reason"}
                </HelpButton>
              ) : null}
              {reopenButton}
            </>
          )}
        </div>
      )}
    </ThreadCard>
  );
}
