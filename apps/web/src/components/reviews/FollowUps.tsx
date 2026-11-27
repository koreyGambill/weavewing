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
import {
  BookmarkIcon,
  CircleCheckIcon,
  FlagIcon,
  MoreHorizontalIcon,
  StickyNoteIcon,
} from "lucide-react";
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
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  bookmarkKey,
  bookmarkMenuActions,
  bookmarkNavigation,
  bookmarkUpdate,
  isBookmarkTodo,
  isOpenBookmarkTodo,
  bookmarkToggle,
} from "./bookmarks.logic";
import { BookmarkNoteEditor } from "./BookmarkNoteEditor";

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

/** Open bookmark to-dos of one thread, for the Checklist count in the view picker. */
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

/** Whether the server keeps a note on each bookmark. */
export function useMessageBookmarkNotesSupported(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.messageBookmarkNotes === true
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
  if (!canWrite) return null;
  return (
    <BookmarkToggles
      environmentId={threadRef.environmentId}
      target={{ threadId: threadRef.threadId, messageId }}
      bookmark={bookmarks.find((item) => item.anchor === undefined) ?? null}
    />
  );
}

/**
 * Icon toggles for one bookmark record: bookmark, to-do flag and, when asked, done. Every surface
 * that changes a bookmark uses these so they keep one shape.
 */
export function BookmarkToggles({
  environmentId,
  target,
  bookmark,
  showDone = false,
}: {
  environmentId: EnvironmentId;
  target: Pick<MessageFollowUp, "threadId" | "messageId">;
  bookmark: MessageFollowUp | null;
  showDone?: boolean;
}) {
  const canWrite = useAtomValue(messageFollowUpsUpdate.permissionAtom(environmentId));
  const supported = useMessageBookmarksSupported(environmentId);
  const notesSupported = useMessageBookmarkNotesSupported(environmentId);
  const update = useMessageFollowUpUpdate();
  const todo = bookmark !== null && isBookmarkTodo(bookmark);
  const bookmarked = bookmark !== null && !todo;
  const done = todo && bookmark.doneAt !== null;
  const toggle = (button: "bookmark" | "todo") =>
    void update(environmentId, bookmarkToggle(target, bookmark, button));
  return (
    <>
      {/* Servers before bookmarks hold only to-dos. */}
      {supported ? (
        <IconToggle
          label={bookmarked ? "Remove bookmark" : todo ? "Keep as bookmark only" : "Bookmark"}
          pressed={bookmarked}
          disabled={!canWrite}
          onClick={() => toggle("bookmark")}
        >
          <BookmarkIcon className={cn("size-3", bookmarked && "fill-current text-warning")} />
        </IconToggle>
      ) : null}
      <IconToggle
        label={todo ? "Remove to-do" : "Flag as to-do"}
        pressed={todo}
        disabled={!canWrite}
        onClick={() => toggle("todo")}
      >
        <FlagIcon
          className={cn(
            "size-3",
            todo && (done ? "text-muted-foreground/60" : "fill-current text-warning"),
          )}
        />
      </IconToggle>
      {showDone && todo ? (
        <IconToggle
          label={done ? "Reopen" : "Mark done"}
          pressed={done}
          disabled={!canWrite}
          onClick={() =>
            void update(environmentId, bookmarkUpdate(bookmark, done ? "reopen" : "done"))
          }
        >
          <CircleCheckIcon className={cn("size-3", done && "text-success-foreground")} />
        </IconToggle>
      ) : null}
      {bookmark && notesSupported && canWrite ? (
        <BookmarkNoteButton environmentId={environmentId} bookmark={bookmark} />
      ) : null}
    </>
  );
}

function BookmarkNoteButton({
  environmentId,
  bookmark,
}: {
  environmentId: EnvironmentId;
  bookmark: MessageFollowUp;
}) {
  const [open, setOpen] = useState(false);
  const label = bookmark.note === undefined ? "Add note" : "Edit note";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  aria-label={label}
                  aria-pressed={bookmark.note !== undefined}
                />
              }
            />
          }
        >
          <StickyNoteIcon
            className={cn("size-3", bookmark.note !== undefined && "fill-current text-warning")}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup aria-label="Bookmark note" padding="none" side="top">
        {open ? (
          <BookmarkNoteEditor
            environmentId={environmentId}
            bookmark={bookmark}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** A bookmark's saved note, kept short where space is tight. */
export function BookmarkNoteText({ note, className }: { note: string; className?: string }) {
  return (
    <p
      className={cn(
        "line-clamp-4 border-l-2 border-warning/60 pl-1.5 whitespace-pre-wrap wrap-anywhere text-foreground/90",
        className,
      )}
    >
      {note}
    </p>
  );
}

/** A bookmark's status, optional text and toggles, for the hover cards beside and over its text. */
export function BookmarkCardBody({
  environmentId,
  bookmark,
  title,
  text,
}: {
  environmentId: EnvironmentId;
  bookmark: MessageFollowUp;
  title: string;
  text?: string;
}) {
  const todo = isBookmarkTodo(bookmark);
  return (
    <div className="w-64 p-2 text-xs">
      <p className="text-muted-foreground">
        {title}
        {todo ? (bookmark.doneAt ? " · done" : " · to-do") : ""}
      </p>
      {text === undefined ? null : <p className="mt-0.5 line-clamp-3 wrap-anywhere">{text}</p>}
      {bookmark.note === undefined ? null : (
        <BookmarkNoteText note={bookmark.note} className="mt-1" />
      )}
      <div className="mt-1.5 flex justify-end gap-0.5">
        <BookmarkToggles
          environmentId={environmentId}
          target={bookmark}
          bookmark={bookmark}
          showDone
        />
      </div>
    </div>
  );
}

function IconToggle({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
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
            disabled={disabled}
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
      ?.querySelector<HTMLElement>('[aria-label="Checklist scope"] [aria-pressed="true"]') ??
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
  const change = (action: MessageFollowUpUpdateInput["action"]) =>
    void update(environmentId, bookmarkUpdate(item, action));
  const jump = () => void navigate(bookmarkNavigation(environmentId, item));
  return (
    <div
      ref={rowRef}
      role="listitem"
      className="flex min-w-0 items-start gap-1.5 rounded-md py-1 pr-0.5 hover:bg-muted/40"
    >
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
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className={cn(
            "line-clamp-2 text-left leading-5 wrap-anywhere hover:underline",
            done && "text-muted-foreground line-through",
          )}
          aria-label={`Jump to bookmark: ${text}`}
          onClick={jump}
        >
          {text}
        </button>
        {item.note === undefined ? null : (
          <BookmarkNoteText note={item.note} className="mt-0.5 text-xs" />
        )}
      </div>
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
 * one, bookmark to-dos across the environment, grouped by thread.
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
    query.data?.filter((item) => {
      if (!isBookmarkTodo(item)) return false;
      if (scoped) return showDone || item.doneAt === null;
      return filter === "all" || (filter === "done") === (item.doneAt !== null);
    }) ?? [];
  const filterControl =
    scoped || !bookmarksSupported ? null : (
      <ToggleGroup
        aria-label="Filter bookmark to-dos"
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
              ? "No bookmark to-dos. Bookmark a message or passage as a to-do to add it here."
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
      aria-label={scoped ? "Bookmarked" : "Bookmark to-dos"}
      className="space-y-1 border-b border-border/60 pb-2"
    >
      <h3 className="flex items-center gap-1.5 px-0.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
        <BookmarkIcon aria-hidden className="size-3" />
        {scoped ? "Bookmarked" : "Bookmark to-dos"}
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
