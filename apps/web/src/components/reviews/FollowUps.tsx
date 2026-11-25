import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type MessageFollowUp,
  type MessageFollowUpUpdateInput,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookmarkIcon, FlagIcon, MoreHorizontalIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { Fragment, useRef, useState, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  messageFollowUpsList,
  messageFollowUpsUpdate,
  useMessageFollowUpUpdate,
} from "../../state/messageFollowUps";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyMedia } from "../ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  bookmarkKey,
  bookmarkMenuActions,
  bookmarkNavigation,
  bookmarkUpdate,
  isBookmarkTodo,
  isOpenBookmarkTodo,
  wholeMessageToggle,
} from "./bookmarks.logic";

/** Servers before bookmarks list only follow-ups, and reject the `bookmarks` mode. */
function useFollowUpsAtom(environmentId: EnvironmentId | null, threadId?: ThreadId) {
  const readable = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const bookmarks = useMessageBookmarksSupported(environmentId);
  return environmentId && readable
    ? messageFollowUpsList({
        environmentId,
        input: {
          ...(threadId === undefined ? {} : { threadId }),
          ...(bookmarks ? { bookmarks: true as const } : {}),
        },
      })
    : null;
}

function useFollowUps(environmentId: EnvironmentId | null, threadId?: ThreadId) {
  return useEnvironmentQuery(useFollowUpsAtom(environmentId, threadId));
}

const NO_BOOKMARKS: ReadonlyArray<MessageFollowUp> = [];
const followUpsOf = (result: AsyncResult.AsyncResult<ReadonlyArray<MessageFollowUp>, unknown>) =>
  AsyncResult.getOrElse(result, () => NO_BOOKMARKS);

/** One thread's bookmarks, for per-message lookups that render on every timeline row. */
export function useThreadFollowUpList(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuerySelector(
    useFollowUpsAtom(threadRef?.environmentId ?? null, threadRef?.threadId),
    followUpsOf,
  );
}

/** Open bookmark to-dos of one thread, for the Todos strip badge. */
export function useOpenFollowUpCount(threadRef: ScopedThreadRef | null) {
  return useThreadFollowUpList(threadRef).filter(isOpenBookmarkTodo).length;
}

/** Every bookmark on one message: the whole message and its passages. */
export function useMessageBookmarks(threadRef: ScopedThreadRef | null, messageId: MessageId) {
  return useThreadFollowUpList(threadRef).filter((item) => item.messageId === messageId);
}

/** Whether the server takes plain bookmarks, assistant messages and passages. */
export function useMessageBookmarksSupported(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.messageBookmarks === true
  );
}

function BookmarkMenuItems({
  environmentId,
  bookmark,
}: {
  environmentId: EnvironmentId;
  bookmark: MessageFollowUp;
}) {
  const update = useMessageFollowUpUpdate();
  return bookmarkMenuActions(bookmark).map(({ label, action }) => (
    <MenuItem
      key={action}
      onClick={() => void update(environmentId, bookmarkUpdate(bookmark, action))}
    >
      {label}
    </MenuItem>
  ));
}

/** Message action row toggles between bookmarked and to-do for the whole message; never shown to agents. */
export function MessageFollowUpButton({
  threadRef,
  messageId,
  bookmarks,
}: {
  threadRef: ScopedThreadRef;
  messageId: MessageId;
  bookmarks: ReadonlyArray<MessageFollowUp>;
}) {
  const canWrite = useAtomValue(messageFollowUpsUpdate.permissionAtom(threadRef.environmentId));
  const supported = useMessageBookmarksSupported(threadRef.environmentId);
  const update = useMessageFollowUpUpdate();
  if (!canWrite) return null;
  const whole = bookmarks.find((item) => item.anchor === undefined) ?? null;
  const todo = whole !== null && isBookmarkTodo(whole);
  const bookmarked = whole !== null && !todo;
  const toggle = (button: "bookmark" | "todo") =>
    void update(
      threadRef.environmentId,
      wholeMessageToggle({ threadId: threadRef.threadId, messageId }, whole, button),
    );
  return (
    <>
      {/* Servers before bookmarks hold only to-dos. */}
      {supported ? (
        <MessageToggleButton
          label={bookmarked ? "Remove bookmark" : todo ? "Keep as bookmark only" : "Bookmark"}
          pressed={bookmarked}
          onClick={() => toggle("bookmark")}
        >
          <BookmarkIcon className={cn("size-3", bookmarked && "fill-current text-warning")} />
        </MessageToggleButton>
      ) : null}
      <MessageToggleButton
        label={todo ? "Remove to-do" : "Flag as to-do"}
        pressed={todo}
        onClick={() => toggle("todo")}
      >
        <FlagIcon
          className={cn(
            "size-3",
            todo && (whole.doneAt ? "text-muted-foreground/60" : "fill-current text-warning"),
          )}
        />
      </MessageToggleButton>
    </>
  );
}

function MessageToggleButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Stays beside a bookmarked message while its action row is hidden, and opens the menu of each
 * of the message's bookmarks.
 */
export function MessageBookmarkMarker({
  threadRef,
  bookmarks,
  className,
}: {
  threadRef: ScopedThreadRef;
  bookmarks: ReadonlyArray<MessageFollowUp>;
  className?: string;
}) {
  const canWrite = useAtomValue(messageFollowUpsUpdate.permissionAtom(threadRef.environmentId));
  if (bookmarks.length === 0) return null;
  const doneOnly = bookmarks.every((item) => isBookmarkTodo(item) && item.doneAt !== null);
  const label = bookmarks.length === 1 ? "Bookmark" : `${bookmarks.length} bookmarks`;
  return (
    <Menu>
      <MenuTrigger
        disabled={!canWrite}
        render={
          <button
            type="button"
            aria-label={`${label} actions`}
            className={cn(
              "absolute -start-5 top-3.5 inline-flex cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default",
              className,
            )}
          />
        }
      >
        <BookmarkIcon
          aria-hidden
          className={cn(
            "size-3",
            doneOnly ? "text-muted-foreground/60" : "fill-current text-warning",
          )}
        />
      </MenuTrigger>
      <MenuPopup align="start">
        {bookmarks.map((item, index) => (
          <Fragment key={bookmarkKey(item)}>
            {index > 0 ? <MenuSeparator /> : null}
            <MenuGroup>
              <MenuGroupLabel>
                <span className="block max-w-64 truncate">
                  {item.anchor === undefined ? "Whole message" : `“${item.excerpt}”`}
                  {isBookmarkTodo(item) ? (item.doneAt ? " · done" : " · to-do") : ""}
                </span>
              </MenuGroupLabel>
              <BookmarkMenuItems environmentId={threadRef.environmentId} bookmark={item} />
            </MenuGroup>
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
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
  const todo = isBookmarkTodo(item);
  const done = item.doneAt !== null;
  const text = item.excerpt || "Message without text";
  const elapsed = formatElapsedDurationLabel(item.flaggedAt, Date.parse(`${nowMinute}:00.000Z`));
  const change = (action: MessageFollowUpUpdateInput["action"]) =>
    void update(environmentId, bookmarkUpdate(item, action));
  const jump = () => void navigate(bookmarkNavigation(environmentId, item));
  return (
    <div
      ref={rowRef}
      role="listitem"
      className="flex min-w-0 items-start gap-1.5 rounded-md py-1 pr-0.5 hover:bg-muted/40"
    >
      {todo ? (
        <Checkbox
          className="mt-0.5"
          aria-label={done ? `Reopen ${text}` : `Mark done: ${text}`}
          checked={done}
          disabled={!canWrite}
          onCheckedChange={() => {
            if (!done && hidesDone) focusAfterRow(rowRef.current)?.focus();
            change(done ? "reopen" : "done");
          }}
        />
      ) : (
        <BookmarkIcon aria-hidden className="mt-1 size-3 shrink-0 fill-current text-warning" />
      )}
      <button
        type="button"
        className={cn(
          "line-clamp-2 min-w-0 flex-1 text-left leading-5 wrap-anywhere hover:underline",
          done && "text-muted-foreground line-through",
        )}
        aria-label={`Jump to bookmark: ${text}`}
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
            <MenuItem onClick={jump}>Jump to bookmark</MenuItem>
            {bookmarkMenuActions(item).map(({ label, action }) => (
              <MenuItem
                key={action}
                disabled={!canWrite}
                onClick={() => {
                  const leaves = action === "unflag" || (hidesDone && action === "done");
                  if (leaves) focusAfterMenu.current = focusAfterRow(rowRef.current);
                  change(action);
                }}
              >
                {label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

type BookmarkFilter = "all" | "todo" | "done";

/**
 * With a thread, its open bookmark to-dos above the todo tree, absent while it has none. Without
 * one, every bookmark on the environment grouped by thread, filtered to to-dos when asked.
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
  const bookmarksSupported = useMessageBookmarksSupported(environmentId);
  const [chosenFilter, setFilter] = useState<BookmarkFilter>("all");
  // Older servers list only open follow-ups across threads, so there is nothing to filter.
  const filter = bookmarksSupported ? chosenFilter : "todo";
  if (query.error) return <p role="alert">{query.error}</p>;
  const scoped = threadId !== undefined;
  const items =
    query.data?.filter((item) =>
      scoped
        ? isBookmarkTodo(item) && (showDone || item.doneAt === null)
        : filter === "all"
          ? true
          : isBookmarkTodo(item) && (filter === "done") === (item.doneAt !== null),
    ) ?? [];
  const filterControl =
    scoped || !bookmarksSupported ? null : (
      <ToggleGroup
        aria-label="Filter bookmarks"
        size="segmented-compact"
        className="w-full *:flex-1"
        value={[filter]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "all" || next === "todo" || next === "done") setFilter(next);
        }}
      >
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="todo">To-do</ToggleGroupItem>
        <ToggleGroupItem value="done">Done</ToggleGroupItem>
      </ToggleGroup>
    );
  if (!items.length)
    return !scoped && query.data ? (
      <div className="space-y-2">
        {filterControl}
        <Empty size="compact">
          <EmptyMedia variant="icon">
            <BookmarkIcon />
          </EmptyMedia>
          <EmptyDescription>
            {filter === "all"
              ? "No bookmarks. Bookmark a message or a passage to come back to it later."
              : filter === "todo"
                ? "No open bookmark to-dos."
                : "No done bookmark to-dos."}
          </EmptyDescription>
        </Empty>
      </div>
    ) : null;
  const groups = new Map<ThreadId, MessageFollowUp[]>();
  for (const item of items) groups.set(item.threadId, [...(groups.get(item.threadId) ?? []), item]);
  return (
    <section
      data-follow-ups
      aria-label={scoped ? "Bookmarked" : "Bookmarks"}
      className="space-y-1 border-b border-border/60 pb-2"
    >
      <h3 className="flex items-center gap-1.5 px-0.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
        <BookmarkIcon aria-hidden className="size-3" />
        {scoped ? "Bookmarked" : "Bookmarks"}
        <span className="tabular-nums">
          {scoped ? items.filter((item) => item.doneAt === null).length : items.length}
        </span>
      </h3>
      {filterControl}
      {[...groups].map(([groupThreadId, group]) => (
        <div key={groupThreadId} className="space-y-0.5">
          {scoped ? null : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: groupThreadId }}
              className="block truncate px-0.5 text-xs text-primary hover:underline"
            >
              {group[0]!.threadTitle || "Untitled thread"}
            </Link>
          )}
          <div role="list">
            {group.map((item) => (
              <FollowUpRow
                key={bookmarkKey(item)}
                environmentId={environmentId}
                item={item}
                hidesDone={scoped ? !showDone : filter !== "all"}
                canWrite={canWrite}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
