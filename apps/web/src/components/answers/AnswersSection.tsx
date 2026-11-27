import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcQueryAtomFamily,
  executeAtomQuery,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ScopedThreadRef, type TrackedAnswersPage } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useStableCallback } from "../../hooks/useStableCallback";
import { DeferEnvironmentQueries, formatEnvironmentQueryError } from "../../state/query";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { focusThreadDraft, showThreadConversation } from "../../lib/sideChatPane";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { CardStatusBadge } from "../questions/QuestionStatusBadge";
import { revealAnswerInChat, revealTrackedMessageInChat } from "../questions/questionReveal";
import { Button } from "../ui/button";
import { observeIntersection } from "../../lib/observeIntersection";
import { useThreadTrackedAsks } from "../../state/threads";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TrackedAnswerBody } from "./ThreadAnswerCard";
import { TrackedAskActions } from "./TrackedAskActions";
import { useTrackedAnswerDraftStore } from "./trackedAnswerDraft";
import { useUpdateTrackedAsk } from "./trackedAnswers-web-state";

const asksRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "answers:history",
  tag: WS_METHODS.threadAsksRead,
  staleTimeMs: 2_000,
  idleTtlMs: 0,
});
type Entry = TrackedAnswersPage["entries"][number];
const empty: ReadonlyArray<Entry> = [];
export function openTrackedAnswersSection(threadRef: ScopedThreadRef) {
  useThreadContextSidebarStore
    .getState()
    .show("checklist", { thread: threadRef, section: "checklist:answers" });
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

function useAnswersPage(
  environmentId: ScopedThreadRef["environmentId"],
  cursor: string | undefined,
  visible: boolean,
) {
  const registry = useContext(RegistryContext);
  const deferred = useContext(DeferEnvironmentQueries);
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly result: AtomCommandResult<TrackedAnswersPage, unknown>;
  } | null>(null);
  const key = JSON.stringify([environmentId, cursor, revision]);
  const result = settled?.key === key ? settled.result : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The RPC belongs to the committed, visible section and is cancelled when it leaves.
  useEffect(() => {
    if (!visible || deferred || result !== null) return;
    const controller = new AbortController();
    // A discarded mount releases its scope before the request can start.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void executeAtomQuery(
        registry,
        asksRead({
          environmentId,
          input: { all: true, ...(cursor === undefined ? {} : { cursor }) },
        }),
        { signal: controller.signal, reportFailure: false },
      ).then((next) => {
        if (!controller.signal.aborted) setSettled({ key, result: next });
      });
    });
    return () => controller.abort();
  }, [cursor, deferred, environmentId, key, registry, result, visible]);
  return {
    data: result?._tag === "Success" ? result.value : null,
    isSuccess: result?._tag === "Success",
    error: result?._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    refresh: () => setRevision((current) => current + 1),
  };
}

export function AnswersSection({
  threadRef,
  scope,
  actions,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly scope: "thread" | "all";
  readonly actions: HTMLDivElement | null;
}) {
  const [visible, setVisible] = useState(false);
  const observeVisibility = useStableCallback((node: HTMLElement | null) => {
    if (node === null) return;
    return observeIntersection(node, (entry) => setVisible(entry.isIntersecting));
  });
  const [pages, setPages] = useState<{ previous: ReadonlyArray<Entry>; cursor?: string }>({
    previous: [],
  });
  const asks = useThreadTrackedAsks(threadRef);
  const query = useAnswersPage(threadRef.environmentId, pages.cursor, visible && scope === "all");
  const entries =
    scope === "thread"
      ? (asks ?? []).map((ask) => ({
          ask,
          threadId: threadRef.threadId,
          archived: false,
          threadTitle: "",
        }))
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
  const refreshAll = () => {
    setPages({ previous: [] });
    query.refresh();
  };
  return (
    <section
      aria-label="Tracked answers"
      ref={observeVisibility}
      className="space-y-1 px-1 text-xs"
    >
      {actions && countLabel
        ? createPortal(
            <span className="max-w-44 truncate text-xs text-muted-foreground">{countLabel}</span>,
            actions,
          )
        : null}
      {scope === "thread" && asks === undefined ? null : scope === "all" &&
        !query.isSuccess &&
        entries.length === 0 ? (
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
            onSaved={scope === "all" ? refreshAll : undefined}
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
  const route = resolveThreadRouteTarget(useParams({ strict: false }));
  const { canUpdate, submit } = useUpdateTrackedAsk(target);
  const answer = ask.answers.at(-1);
  const key = scopedThreadKey(target);
  const discussed = useTrackedAnswerDraftStore(
    (state) => state.drafts[key]?.discuss.some((item) => item.id === ask.id) ?? false,
  );
  const navigateToThread = async () => {
    if (route?.kind !== "server" || scopedThreadKey(route.threadRef) !== key)
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
    showThreadConversation(target);
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
                  onClick={() => {
                    useTrackedAnswerDraftStore.getState().toggleDiscuss(key, ask);
                    if (!discussed) void navigateToThread().then(() => focusThreadDraft(target));
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
