import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type MessageFollowUp,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { FlagIcon, MoreHorizontalIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useRef } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { messageRevealNavigation } from "../../lib/assistantCitationNavigation";
import { cn } from "../../lib/utils";
import {
  messageFollowUpsList,
  messageFollowUpsUpdate,
  useMessageFollowUpUpdate,
} from "../../state/messageFollowUps";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyMedia } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function useFollowUpsAtom(environmentId: EnvironmentId | null, threadId?: ThreadId) {
  const readable = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return environmentId && readable
    ? messageFollowUpsList({
        environmentId,
        input: threadId === undefined ? {} : { threadId },
      })
    : null;
}

function useFollowUps(environmentId: EnvironmentId | null, threadId?: ThreadId) {
  return useEnvironmentQuery(useFollowUpsAtom(environmentId, threadId));
}

const NO_FOLLOW_UPS: ReadonlyArray<MessageFollowUp> = [];
const followUpsOf = (result: AsyncResult.AsyncResult<ReadonlyArray<MessageFollowUp>, unknown>) =>
  AsyncResult.getOrElse(result, () => NO_FOLLOW_UPS);

/** One thread's follow-ups, for per-message lookups that render on every timeline row. */
export function useThreadFollowUpList(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuerySelector(
    useFollowUpsAtom(threadRef?.environmentId ?? null, threadRef?.threadId),
    followUpsOf,
  );
}

/** Open follow-ups of one thread, for the Todos strip badge. */
export function useOpenFollowUpCount(threadRef: ScopedThreadRef | null) {
  return useThreadFollowUpList(threadRef).filter((item) => item.doneAt === null).length;
}

export function useMessageFollowUp(threadRef: ScopedThreadRef | null, messageId: MessageId) {
  return useThreadFollowUpList(threadRef).find((item) => item.messageId === messageId) ?? null;
}

/** Message action row toggle; the user's own reminder, never shown to agents. */
export function MessageFollowUpButton({
  threadRef,
  messageId,
  followUp,
}: {
  threadRef: ScopedThreadRef;
  messageId: MessageId;
  followUp: MessageFollowUp | null;
}) {
  const canWrite = useAtomValue(messageFollowUpsUpdate.permissionAtom(threadRef.environmentId));
  const update = useMessageFollowUpUpdate();
  if (!canWrite) return null;
  const label = followUp ? "Remove follow-up" : "Follow up later";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={followUp !== null}
            onClick={() =>
              void update(threadRef.environmentId, {
                threadId: threadRef.threadId,
                messageId,
                action: followUp ? "unflag" : "flag",
              })
            }
          />
        }
      >
        <FlagIcon className={cn("size-3", followUp && "fill-current text-warning")} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Stays visible beside a flagged message while its action row is hidden. */
export function MessageFollowUpGlyph({ followUp }: { followUp: MessageFollowUp }) {
  return (
    <FlagIcon
      aria-label={followUp.doneAt ? "Followed up" : "Flagged to follow up"}
      className={cn(
        "absolute -start-5 top-3.5 size-3",
        followUp.doneAt ? "text-muted-foreground/60" : "fill-current text-warning",
      )}
    />
  );
}

/** Where focus goes when a row leaves: a neighbour, else the scope switch, which stays put. */
function focusAfterRow(row: HTMLElement | null) {
  const boxes = [
    ...(row?.closest("[data-follow-ups]")?.querySelectorAll<HTMLElement>('[role="checkbox"]') ??
      []),
  ];
  const at = boxes.findIndex((box) => row?.contains(box));
  return (
    boxes[at + 1] ??
    boxes[at - 1] ??
    row
      ?.closest("[data-todos-view]")
      ?.querySelector<HTMLElement>('[aria-label="Todos scope"] [aria-pressed="true"]') ??
    null
  );
}

function FollowUpRow({
  environmentId,
  item,
  hidesDone,
  canWrite,
}: {
  environmentId: EnvironmentId;
  item: MessageFollowUp;
  hidesDone: boolean;
  canWrite: boolean;
}) {
  const navigate = useNavigate();
  const update = useMessageFollowUpUpdate();
  const nowMinute = useNowMinute();
  const rowRef = useRef<HTMLDivElement>(null);
  const focusAfterMenu = useRef<HTMLElement | null>(null);
  const done = item.doneAt !== null;
  const text = item.excerpt || "Message without text";
  const elapsed = formatElapsedDurationLabel(item.flaggedAt, Date.parse(`${nowMinute}:00.000Z`));
  const change = (action: "done" | "reopen" | "unflag") =>
    void update(environmentId, { threadId: item.threadId, messageId: item.messageId, action });
  const jump = () =>
    void navigate(messageRevealNavigation(environmentId, item.threadId, item.messageId));
  return (
    <div
      ref={rowRef}
      role="listitem"
      className="flex min-w-0 items-start gap-1.5 rounded-md py-1 pr-0.5 hover:bg-muted/40"
    >
      <Checkbox
        className="mt-0.5"
        aria-label={done ? `Reopen ${text}` : `Mark followed up: ${text}`}
        checked={done}
        disabled={!canWrite}
        onCheckedChange={() => {
          if (!done && hidesDone) focusAfterRow(rowRef.current)?.focus();
          change(done ? "reopen" : "done");
        }}
      />
      <button
        type="button"
        className={cn(
          "line-clamp-2 min-w-0 flex-1 text-left leading-5 wrap-anywhere hover:underline",
          done && "text-muted-foreground line-through",
        )}
        aria-label={`Jump to message: ${text}`}
        onClick={jump}
      >
        {text}
      </button>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <time dateTime={item.flaggedAt} className="text-3xs text-muted-foreground tabular-nums">
          {elapsed === "just now" ? "now" : elapsed}
        </time>
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost" size="icon-tiny" aria-label={`Actions for ${text}`} />}
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup
            align="end"
            finalFocus={() => {
              const next = focusAfterMenu.current;
              focusAfterMenu.current = null;
              return next ?? true;
            }}
          >
            <MenuItem onClick={jump}>Jump to message</MenuItem>
            <MenuItem
              disabled={!canWrite}
              onClick={() => {
                focusAfterMenu.current = focusAfterRow(rowRef.current);
                change("unflag");
              }}
            >
              Remove flag
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

/**
 * With a thread, its follow-ups above the todo tree, absent while it has none. Without one, the
 * environment's open follow-ups grouped by thread.
 */
export function FollowUpSection({
  environmentId,
  threadId,
  showDone,
}: {
  environmentId: EnvironmentId;
  threadId?: ThreadId;
  showDone: boolean;
}) {
  const query = useFollowUps(environmentId, threadId);
  const canWrite = useAtomValue(messageFollowUpsUpdate.permissionAtom(environmentId));
  if (query.error) return <p role="alert">{query.error}</p>;
  const items = query.data?.filter((item) => showDone || item.doneAt === null) ?? [];
  if (!items.length)
    return threadId === undefined && query.data ? (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <FlagIcon />
        </EmptyMedia>
        <EmptyDescription>
          No follow-ups. Flag a message you send to come back to it later.
        </EmptyDescription>
      </Empty>
    ) : null;
  const groups = new Map<ThreadId, MessageFollowUp[]>();
  for (const item of items) groups.set(item.threadId, [...(groups.get(item.threadId) ?? []), item]);
  return (
    <section
      data-follow-ups
      aria-label="Follow-ups"
      className="space-y-1 border-b border-border/60 pb-2"
    >
      <h3 className="flex items-center gap-1.5 px-0.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
        <FlagIcon aria-hidden className="size-3" />
        Follow up
        <span className="tabular-nums">{items.filter((item) => item.doneAt === null).length}</span>
      </h3>
      {[...groups].map(([groupThreadId, group]) => (
        <div key={groupThreadId} className="space-y-0.5">
          {threadId === undefined ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: groupThreadId }}
              className="block truncate px-0.5 text-xs text-primary hover:underline"
            >
              {group[0]!.threadTitle || "Untitled thread"}
            </Link>
          ) : null}
          <div role="list">
            {group.map((item) => (
              <FollowUpRow
                key={item.messageId}
                environmentId={environmentId}
                item={item}
                hidesDone={!showDone}
                canWrite={canWrite}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
