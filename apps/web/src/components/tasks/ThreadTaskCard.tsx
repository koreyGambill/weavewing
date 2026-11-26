import { useAtomValue } from "@effect/atom-react";
import type { ListItem, ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useRef, useState } from "react";

import { threadTaskUpdate } from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { threadTaskElementId } from "../questions/questionReveal";
import { CardStatusBadge, type CardBadgeVariant } from "../questions/QuestionStatusBadge";
import {
  HelpButton,
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
import { taskCardOutcome, taskCardStatus, type TaskCardStatus } from "./taskCard.logic";

const HELP = {
  dismiss: "Cancel this task. Nothing is sent to the agent; it hears with your next message.",
  discuss: "Put a reference to this task in the composer and write about it there.",
  discussOff: "Take the reference to this task out of the composer.",
  done: "You did it. Nothing is sent to the agent; it hears with your next message.",
  reopen: "Open this again. Nothing is sent to the agent.",
};

const STATUS: Record<
  TaskCardStatus,
  { readonly label: string; readonly variant: CardBadgeVariant; readonly help: string }
> = {
  open: {
    label: "Open",
    variant: "outline",
    help: "Only you can do this. Mark it Done when you have.",
  },
  "in-composer": {
    label: "In composer",
    variant: "info-outline",
    help: "A reference to this task is in your composer. It goes with your next message.",
  },
  discussing: {
    label: "Discussing",
    variant: "warning-outline",
    help: "You sent a message about this task. The agent records what it settled; you can still mark it here.",
  },
  "done-by-you": {
    label: "Done by you",
    variant: "success-outline",
    help: "You marked this done.",
  },
  recorded: {
    label: "Recorded by the agent",
    variant: "success-outline",
    help: "The agent recorded this as done from your message. Reopen it if the agent misread you.",
  },
  cancelled: { label: "Cancelled", variant: "outline", help: "Closed without doing it." },
};

/** A task's badge, with the recorded note as its meaning when the agent or user left one. */
export function TaskStatusBadge({ status, note }: { status: TaskCardStatus; note: string }) {
  const { label, variant, help } = STATUS[status];
  const noted = note !== "" && (status === "recorded" || status === "cancelled");
  return <CardStatusBadge label={label} variant={variant} help={noted ? note : help} />;
}

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
  const focusNext = useRef<"line" | "card" | null>(null);
  const status = taskCardStatus(task, inComposer);
  const waiting = task.state === "open";
  const usable = canAct && !busy;
  const label = `${task.ref}: ${task.text}`;
  const note = task.note?.trim() ?? "";
  const outcome = taskCardOutcome(task);
  const record = () =>
    waitingItemDiscussRecord({ itemKind: "task", key: task.id, ref: task.ref, title: task.text });

  const setState = async (state: "open" | "done" | "dropped") => {
    setBusy(true);
    const result = await update({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        expectedRevision: revision,
        changes: [{ id: task.id, state }],
      },
    });
    setBusy(false);
    return result._tag === "Success";
  };
  const settle = async (state: "done" | "dropped") => {
    focusNext.current = "line";
    removeWaitingItemDiscuss(threadRef, "task", task.id);
    if (!(await setState(state))) focusNext.current = null;
    setExpanded(false);
  };
  const reopen = async () => {
    focusNext.current = "card";
    setExpanded(false);
    if (!(await setState("open"))) focusNext.current = null;
  };
  const focusOnMount = (target: "line" | "card") => (node: HTMLButtonElement | null) => {
    if (node === null || focusNext.current !== target) return;
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
        {reopenButton}
      </ThreadCardClosedLine>
    );
  }

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
      controls={<TaskStatusBadge status={status} note={note} />}
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
          reopenButton
        )}
      </div>
    </ThreadCard>
  );
}
