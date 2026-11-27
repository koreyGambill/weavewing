import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ScopedThreadRef, type TrackedAnswersPage } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { CardStatusBadge } from "../questions/QuestionStatusBadge";
import { revealAnswerInChat, revealTrackedMessageInChat } from "../questions/questionReveal";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { focusNearestComposer } from "../waiting/waitingItemComposer";
import { TrackedAnswerBody } from "./ThreadAnswerCard";
import { TrackedAskActions } from "./TrackedAskActions";
import { useTrackedAnswerDraftStore } from "./trackedAnswerDraft";
import { useTrackedAsks, useUpdateTrackedAsk } from "./trackedAnswers-web-state";

const asksRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "answers:history",
  tag: WS_METHODS.threadAsksRead,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
type Entry = TrackedAnswersPage["entries"][number];
const empty: ReadonlyArray<Entry> = [];
const useSectionOpen = create<Record<string, boolean>>(() => ({}));

export function openTrackedAnswersSection(threadRef: ScopedThreadRef) {
  useSectionOpen.setState({ [scopedThreadKey(threadRef)]: true });
}

const labels = {
  queued: "Queued",
  owed: "Owed",
  answered: "Answered",
  closed: "Got it",
  withdrawn: "Withdrawn",
};
const rank = { answered: 0, owed: 1, queued: 1, closed: 2, withdrawn: 2 };
const byPriority = (a: Entry, b: Entry) =>
  rank[a.ask.state] - rank[b.ask.state] || b.ask.createdAt.localeCompare(a.ask.createdAt);

export function AnswersSection({
  threadRef,
  scope,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly scope: "thread" | "all";
}) {
  const key = scopedThreadKey(threadRef);
  const open = useSectionOpen((state) => state[key] === true);
  const [visible, setVisible] = useState(false);
  const observeVisibility = useStableCallback((node: HTMLElement | null) => {
    if (node === null) return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting === true),
    );
    observer.observe(node);
    return () => observer.disconnect();
  });
  const [pages, setPages] = useState<{ previous: ReadonlyArray<Entry>; cursor?: string }>({
    previous: [],
  });
  const asks = useTrackedAsks(threadRef);
  const query = useEnvironmentQuery(
    open && visible && scope === "all"
      ? asksRead({
          environmentId: threadRef.environmentId,
          input: { all: true, ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }) },
        })
      : null,
  );
  const entries =
    scope === "thread"
      ? asks.map((ask) => ({ ask, threadId: threadRef.threadId, archived: false, threadTitle: "" }))
      : [...pages.previous, ...(query.data?.entries ?? empty)];
  const sorted = scope === "thread" ? entries.toSorted(byPriority) : entries;
  const counts = query.data?.counts ?? {
    owed: entries.filter((entry) => entry.ask.state === "owed" || entry.ask.state === "queued")
      .length,
    toRead: entries.filter((entry) => entry.ask.state === "answered").length,
    closed: entries.filter((entry) => entry.ask.state === "closed").length,
  };
  const countLabel = [
    counts.owed > 0 ? `${counts.owed} owed` : "",
    counts.toRead > 0 ? `${counts.toRead} to read` : "",
    counts.closed > 0 ? `${counts.closed} closed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const next = query.data?.cursor;
  return (
    <section aria-label="Tracked answers" ref={observeVisibility}>
      <CollapsibleSectionHeader
        expanded={open}
        variant="panel"
        onClick={() => useSectionOpen.setState({ [key]: !open })}
        accessory={
          countLabel ? (
            <span className="shrink-0 text-muted-foreground">{countLabel}</span>
          ) : undefined
        }
      >
        Answers
      </CollapsibleSectionHeader>
      {open ? (
        <div className="space-y-1 px-1">
          {scope === "all" && !query.isSuccess && entries.length === 0 ? (
            <p role="status" className="text-muted-foreground">
              {query.error ?? "Loading tracked answers…"}
            </p>
          ) : sorted.length === 0 ? (
            <p className="px-1 text-muted-foreground">
              {scope === "thread"
                ? "No tracked answers in this thread. Turn on Track answer in the composer when you want one."
                : "No tracked answers in this environment."}
            </p>
          ) : (
            sorted.map((entry) => (
              <AnswerListRow
                key={`${entry.threadId}:${entry.ask.id}`}
                entry={entry}
                current={threadRef}
                onSaved={scope === "all" ? query.refresh : undefined}
              />
            ))
          )}
          {next ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => setPages({ previous: entries, cursor: next })}
            >
              Show more
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AnswerListRow({
  entry,
  current,
  onSaved,
}: {
  readonly entry: Entry;
  readonly current: ScopedThreadRef;
  readonly onSaved?: (() => void) | undefined;
}) {
  const { ask } = entry;
  const target = { environmentId: current.environmentId, threadId: entry.threadId };
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { canUpdate, submit } = useUpdateTrackedAsk(target);
  const answer = ask.answers.at(-1);
  const key = scopedThreadKey(target);
  const discussed = useTrackedAnswerDraftStore(
    (state) => state.drafts[key]?.discuss.some((item) => item.id === ask.id) ?? false,
  );
  const navigateToThread = async () => {
    if (target.threadId !== current.threadId)
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
  const showInChat = async () => {
    await navigateToThread();
    if (answer && (ask.state === "answered" || ask.state === "closed"))
      revealAnswerInChat(key, ask.id, answer.n);
    else revealTrackedMessageInChat(key, ask.askedInMessageId);
  };
  const gotIt = async () => {
    setBusy(true);
    const saved = await submit({ threadId: target.threadId, id: ask.id, action: "close" });
    setBusy(false);
    if (saved) onSaved?.();
  };
  const timestamp = answer?.answeredAt ?? ask.createdAt;
  const nowMinute = useNowMinute();
  return (
    <div
      className="min-w-0 rounded-md border border-border"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded && !event.defaultPrevented) {
          const heading =
            event.currentTarget.querySelector<HTMLButtonElement>("[data-answer-heading]");
          setExpanded(false);
          heading?.focus();
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-answer-heading
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => setExpanded(!expanded)}
      >
        <strong className="shrink-0">{ask.id}</strong>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{ask.question}</span>
          {entry.threadTitle ? (
            <span className="block truncate text-muted-foreground">
              {entry.threadTitle}
              {entry.archived ? " · Archived" : ""}
            </span>
          ) : null}
          {!expanded && answer ? (
            <span className="block truncate text-muted-foreground">
              {answer.text.split("\n")[0]}
            </span>
          ) : null}
        </span>
        <CardStatusBadge
          label={labels[ask.state]}
          help={labels[ask.state]}
          variant={ask.state === "closed" ? "success-outline" : "outline"}
        />
        <Tooltip>
          <TooltipTrigger
            render={<time className="shrink-0 text-muted-foreground" dateTime={timestamp} />}
          >
            {formatElapsedDurationLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`))}
          </TooltipTrigger>
          <TooltipPopup side="top">{new Date(timestamp).toLocaleString()}</TooltipPopup>
        </Tooltip>
      </button>
      {expanded ? (
        <div className="space-y-2 px-2 pb-2">
          {answer ? <TrackedAnswerBody answer={answer} threadRef={target} /> : null}
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button size="xs" variant="ghost-muted" onClick={() => void showInChat()}>
              Show in chat
            </Button>
            <TrackedAskActions
              ask={ask}
              threadRef={target}
              onShow={() => void showInChat()}
              {...(onSaved ? { onSaved } : {})}
            />
            {ask.state === "answered" ? (
              <>
                <Button
                  size="xs"
                  variant="contrast-outline"
                  disabled={!canUpdate}
                  aria-pressed={discussed}
                  onClick={(event) => {
                    const from = event.currentTarget;
                    useTrackedAnswerDraftStore.getState().toggleDiscuss(key, ask);
                    if (!discussed) void navigateToThread().then(() => focusNearestComposer(from));
                  }}
                >
                  Discuss
                </Button>
                <Button size="xs" disabled={!canUpdate || busy} onClick={() => void gotIt()}>
                  Got it
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
