import { type ScopedThreadRef, type TrackedAnswer, type TrackedAsk } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import ChatMarkdown from "../ChatMarkdown";
import { findRevealRef } from "../chat/markdownFindContext";
import { useTallEnoughToFold } from "../chat/useTallEnoughToFold";
import { CardStatusBadge, type CardBadgeVariant } from "../questions/QuestionStatusBadge";
import {
  HelpButton,
  ThreadCard,
  ThreadCardClosedLine,
  ThreadCardHeading,
} from "../questions/ThreadCardShell";
import { Button } from "../ui/button";
import { useUpdateTrackedAsk } from "./trackedAnswers-web-state";

function answerCardElementId(id: string) {
  return `thread-answer-${id}`;
}

const ARTIFACT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function TrackedAnswerBody({
  answer,
  threadRef,
  cwd,
}: {
  readonly answer: TrackedAnswer;
  readonly threadRef: ScopedThreadRef;
  readonly cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const more = answer.more?.trim();
  const artifactId = more?.startsWith("artifact:")
    ? more.slice("artifact:".length).trim()
    : more && ARTIFACT_ID.test(more)
      ? more
      : null;
  const { ref: contentRef, tallEnough } = useTallEnoughToFold(true, 20);
  const clamped = tallEnough && !expanded;
  const reveal = findRevealRef(() => setExpanded(true));
  return (
    <div className="min-w-0 space-y-1.5">
      <div
        ref={reveal}
        data-thread-find-text="true"
        data-thread-find-fold={clamped ? "" : undefined}
        className={cn(
          "min-w-0",
          clamped &&
            "max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_80%,transparent)]",
        )}
      >
        <div ref={contentRef}>
          <ChatMarkdown text={answer.text} cwd={cwd} threadRef={threadRef} parseRawHtml={false} />
        </div>
      </div>
      {tallEnough ? (
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show all"}
        </Button>
      ) : null}
      {more ? (
        <div className="flex items-baseline gap-2 px-1.5 py-1">
          <span className="shrink-0 text-xs text-muted-foreground">More</span>
          <div className="min-w-0 break-words text-xs">
            {artifactId ? (
              <div className="min-w-0 [&>button]:max-w-full">
                <Button
                  size="xs"
                  variant="link"
                  onClick={() =>
                    useThreadContextSidebarStore.getState().show("artifacts", {
                      thread: threadRef,
                      artifactId,
                    })
                  }
                >
                  <span className="min-w-0 truncate">{artifactId}</span>
                </Button>
              </div>
            ) : (
              <ChatMarkdown text={more} cwd={cwd} threadRef={threadRef} parseRawHtml={false} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ThreadAnswerCard({
  ask,
  answer,
  threadRef,
  onAsked,
  discussInComposer,
  onDiscuss,
  cwd,
}: {
  readonly ask: TrackedAsk;
  readonly answer: TrackedAnswer;
  readonly threadRef: ScopedThreadRef;
  readonly onAsked: () => void;
  readonly discussInComposer: boolean;
  readonly onDiscuss: (from: HTMLElement) => void;
  readonly cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const focusNext = useRef<"line" | "card" | null>(null);
  const { canUpdate, submit } = useUpdateTrackedAsk(threadRef);
  const latest = ask.answers.at(-1)?.n === answer.n;
  const waiting = latest && ask.state === "answered";
  const discussing = latest && ask.state === "owed";
  const closed = latest && ask.state === "closed";
  const collapsible = !waiting && !discussing;
  const id = latest ? answerCardElementId(ask.id) : `${answerCardElementId(ask.id)}-${answer.n}`;
  const label = `${ask.id}: ${ask.question}`;
  const [status, variant]: [string, CardBadgeVariant] = !latest
    ? ["Replaced", "outline"]
    : closed
      ? ["Got it", "success-outline"]
      : discussing
        ? ["Discussing", "warning-outline"]
        : ask.state === "withdrawn"
          ? ["Withdrawn", "outline"]
          : discussInComposer
            ? ["In composer", "info-outline"]
            : ["Answered", "outline"];
  const badge = <CardStatusBadge label={status} variant={variant} help={status} />;
  const focus = (target: "line" | "card") => (button: HTMLButtonElement | null) => {
    if (!button || button.disabled || focusNext.current !== target) return;
    focusNext.current = null;
    button.focus();
  };
  const write = async (action: "close" | "reopen") => {
    focusNext.current = action === "close" ? "line" : "card";
    setBusy(true);
    if (await submit({ threadId: threadRef.threadId, id: ask.id, action })) setExpanded(false);
    else focusNext.current = null;
    setBusy(false);
  };
  const reopen = closed ? (
    <HelpButton
      help="Show this answer as new again. Starts no turn."
      disabled={!canUpdate || busy}
      onClick={() => void write("reopen")}
    >
      Reopen
    </HelpButton>
  ) : null;
  if (collapsible && !expanded) {
    return (
      <ThreadCardClosedLine
        id={id}
        label={label}
        refLabel={ask.id}
        title={ask.question}
        outcome={
          latest
            ? (answer.text.split("\n")[0] ?? null)
            : `Answer ${answer.n} of ${ask.answers.length}`
        }
        expandRef={focus("line")}
        onExpand={() => setExpanded(true)}
        stackOnNarrow
      >
        {badge}
        {reopen}
      </ThreadCardClosedLine>
    );
  }
  return (
    <ThreadCard
      id={id}
      label={label}
      waiting={waiting}
      heading={<ThreadCardHeading refLabel={ask.id} title={ask.question} editable={waiting} />}
      controls={badge}
      onCollapse={collapsible ? () => setExpanded(false) : undefined}
    >
      <div className="flex items-baseline gap-2 px-1.5 py-1">
        <span className="shrink-0 text-xs text-muted-foreground">Asked</span>
        <Button
          size="xs"
          variant="link"
          title={new Date(ask.createdAt).toLocaleString()}
          onClick={onAsked}
        >
          {ask.about ? `Follow-up on ${ask.about.ref}` : "In your message"}
        </Button>
      </div>
      <TrackedAnswerBody
        answer={answer}
        threadRef={threadRef}
        {...(cwd === undefined ? {} : { cwd })}
      />
      {waiting ? (
        <div className="flex flex-wrap justify-end gap-1">
          <HelpButton
            help={`Write a follow-up in the composer. Sending it makes ${ask.id} owed again.`}
            aria-pressed={discussInComposer}
            disabled={!canUpdate || busy}
            onClick={(event) => onDiscuss(event.currentTarget)}
          >
            Discuss
          </HelpButton>
          <HelpButton
            variant="default"
            ref={focus("card")}
            disabled={!canUpdate || busy}
            help="Close this answer. It stays in this thread's Checklist under Answers."
            onClick={() => void write("close")}
          >
            Got it
          </HelpButton>
        </div>
      ) : (
        reopen
      )}
    </ThreadCard>
  );
}
