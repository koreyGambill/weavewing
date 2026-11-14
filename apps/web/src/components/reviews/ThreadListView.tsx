import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  ThreadId,
  LIST_MAX_DEPTH,
  listItemNeedsHandoff,
  type ListItem,
  type ScopedThreadRef,
  type ThreadListEntry,
  type ThreadListUpdateInput,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  ListIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  NotebookTextIcon,
  PlusIcon,
  UserIcon,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadArtifactList, threadListRead, threadListUpdate } from "../../state/threadWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Empty, EmptyDescription, EmptyMedia } from "../ui/empty";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem as GroupToggle } from "../ui/toggle-group";
import {
  todoIndentMove,
  todoTabUpdate,
  todoTree,
  visibleTodoIds,
  type TodoFilter,
  type TodoNode,
} from "./todoList.logic";

type Owner = ListItem["owner"];
type Change = ThreadListUpdateInput["changes"][number];

const filterLabels: Record<TodoFilter, string> = { all: "All", mine: "Mine", agents: "Agents" };
const filterOptions = [
  { value: "all", Icon: ListIcon, iconClass: undefined },
  { value: "mine", Icon: UserIcon, iconClass: "text-success-foreground" },
  { value: "agents", Icon: BotIcon, iconClass: "text-(--weavewing-yellow)" },
] as const;

/** A radio item's label with its check on the right, which the menu's radio items omit. */
export function CheckedLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center justify-between gap-4">
      {children}
      <MenuRadioItemIndicator />
    </span>
  );
}

const ownerLabel = (owner: Owner) =>
  owner === "agent" ? "Agent is responsible" : "You're responsible";

export function ThreadListView({
  threadRef,
  entry: supplied,
  onRefresh,
}: {
  threadRef: ScopedThreadRef;
  entry?: ThreadListEntry;
  onRefresh?: () => void;
}) {
  const readable = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    !supplied && readable
      ? threadListRead({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, all: true },
        })
      : null,
  );
  const artifacts = useEnvironmentQuery(
    readable
      ? threadArtifactList({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const canWrite = useAtomValue(threadListUpdate.permissionAtom(threadRef.environmentId));
  const update = useAtomCommand(threadListUpdate, { reportFailure: false });
  const filter = useThreadContextSidebarStore((state) => state.todoFilter);
  const showClosed = useThreadContextSidebarStore((state) => state.todoShowClosed);
  const newItemRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<ThreadListEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [owner, setOwner] = useState<Owner>("you");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [parent, setParent] = useState<ListItem | null>(null);
  const [notesOpen, setNotesOpen] = useState(true);
  // Kept here so an item's editor stays open when indenting moves its row to a new parent.
  const [editing, setEditing] = useState<string | null>(null);
  const focusTextRef = useRef<string | null>(null);
  const [error, setError] = useState("");
  const remote = supplied ?? query.data?.[0];
  const entry = saved && (!remote || saved.revision > remote.revision) ? saved : remote;
  const mutate = async (change: Pick<ThreadListUpdateInput, "changes" | "order">) => {
    if (!entry || busy || !canWrite) return;
    setBusy(true);
    setError("");
    let ok = false;
    const result = await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, expectedRevision: entry.revision, ...change },
    });
    if (result._tag === "Success") {
      ok = true;
      setSaved({
        ...entry,
        ...result.value,
        items: supplied ? result.value.items.filter((item) => item.needsQa) : result.value.items,
      });
      query.refresh();
      artifacts.refresh();
      onRefresh?.();
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
      query.refresh();
    }
    setBusy(false);
    return ok;
  };
  if (!readable)
    return <p className="text-xs text-muted-foreground">This connection cannot read todos.</p>;
  if (!entry)
    return <p className="text-xs text-muted-foreground">{query.error ?? "Loading todos…"}</p>;
  const tree = supplied
    ? todoTree(entry.items, { filter: "all", showClosed: true })
    : todoTree(entry.items, { filter, showClosed });
  const done = entry.items.filter((item) => item.state === "done").length;
  const move = (id: string, direction: number) => {
    const order = entry.items.map((item) => item.id);
    const from = order.indexOf(id);
    const to = from + direction;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    void mutate({ changes: [], order });
  };
  const visible = visibleTodoIds(tree);
  /** `draftText` is undefined from the menu, and the editor's draft (or null) from Tab. */
  const indent = (id: string, direction: "in" | "out", draftText?: string | null) => {
    const update = todoTabUpdate(entry.items, id, draftText ?? null, direction, visible);
    if (!update) return false;
    focusTextRef.current = draftText === undefined ? null : id;
    void mutate(update);
    return true;
  };
  const artifactCounts = new Map(
    artifacts.data?.map((artifact) => [artifact.id, artifact.unansweredQuestions]),
  );
  const artifactTitles = new Map(artifacts.data?.map((artifact) => [artifact.id, artifact.title]));
  const renderBranch = (node: TodoNode, depth: number) => (
    <div key={node.item.id} role="listitem">
      <TodoRow
        crossThread={Boolean(supplied)}
        node={node}
        expanded={editing === node.item.id}
        onExpandedChange={(open) => setEditing(open ? node.item.id : null)}
        takeTextFocus={() => {
          if (focusTextRef.current !== node.item.id) return false;
          focusTextRef.current = null;
          return true;
        }}
        collapsed={collapsed.has(node.item.id)}
        onToggle={() =>
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(node.item.id)) next.delete(node.item.id);
            else next.add(node.item.id);
            return next;
          })
        }
        onAddChild={depth < LIST_MAX_DEPTH - 1 ? () => setParent(node.item) : undefined}
        newItemRef={newItemRef}
        disabled={!canWrite || busy}
        onChange={(change) => void mutate({ changes: [{ id: node.item.id, ...change }] })}
        onMove={supplied ? undefined : (direction) => move(node.item.id, direction)}
        canIndent={
          !supplied && todoIndentMove(entry.items, node.item.id, "in", visible) !== undefined
        }
        canOutdent={
          !supplied && todoIndentMove(entry.items, node.item.id, "out", visible) !== undefined
        }
        onIndent={(direction, draftText) => indent(node.item.id, direction, draftText)}
        artifactCounts={artifactCounts}
        artifactTitles={artifactTitles}
        threadRef={threadRef}
      />
      {node.children.length && !collapsed.has(node.item.id) ? (
        <div role="list" className="ml-[7px] border-l border-border/60 pl-2">
          {node.children.map((child) => renderBranch(child, depth + 1))}
        </div>
      ) : null}
    </div>
  );
  return (
    <div className="@container mx-auto w-full max-w-4xl space-y-2 text-xs">
      {!supplied ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ToggleGroup
            aria-label="Filter todos by who is responsible"
            size="segmented-compact"
            value={[filter]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "all" || next === "mine" || next === "agents")
                useThreadContextSidebarStore.getState().setTodoFilter(next);
            }}
          >
            {filterOptions.map(({ value, Icon, iconClass }) => (
              <Tooltip key={value}>
                <TooltipTrigger
                  render={<GroupToggle value={value} aria-label={filterLabels[value]} />}
                >
                  <Icon className={iconClass} />
                  <span className="hidden @min-[22rem]:inline">{filterLabels[value]}</span>
                </TooltipTrigger>
                <TooltipPopup>{filterLabels[value]}</TooltipPopup>
              </Tooltip>
            ))}
          </ToggleGroup>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={showClosed ? "Showing done and dropped" : "Hiding done and dropped"}
                />
              }
            >
              {showClosed ? <EyeIcon /> : <EyeOffIcon />}
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuCheckboxItem
                variant="switch"
                checked={showClosed}
                onCheckedChange={(checked) =>
                  useThreadContextSidebarStore.getState().setTodoShowClosed(checked)
                }
              >
                Show done and dropped
              </MenuCheckboxItem>
            </MenuPopup>
          </Menu>
          {entry.items.length ? (
            <span
              className="ml-auto shrink-0 tabular-nums text-muted-foreground"
              aria-label={`${done} of ${entry.items.length} done`}
            >
              {done}/{entry.items.length}
              <span className="hidden @min-[22rem]:inline"> done</span>
            </span>
          ) : null}
        </div>
      ) : null}
      <div role="list" aria-label="Todos">
        {tree.map((node) => renderBranch(node, 0))}
      </div>
      {!tree.length ? (
        entry.items.length ? (
          <p className="px-1 py-2 text-muted-foreground">
            Nothing here. {filter === "all" ? "Show done and dropped to see the rest." : "Try All."}
          </p>
        ) : (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <ListChecksIcon />
            </EmptyMedia>
            <EmptyDescription>
              No todos yet. Add one below, or ask an agent to track its work here.
            </EmptyDescription>
          </Empty>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!supplied ? (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim())
              void mutate({
                changes: [{ text: text.trim(), owner, parentId: parent?.id ?? null }],
              }).then((ok) => {
                if (ok) {
                  setText("");
                  setParent(null);
                }
              });
          }}
        >
          {parent ? (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">Under: {parent.text}</span>
              <Button size="xs" variant="ghost" onClick={() => setParent(null)}>
                Cancel
              </Button>
            </div>
          ) : null}
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`New todo owner: ${owner === "you" ? "you" : "agent"}`}
                    disabled={!canWrite || busy}
                    onClick={() => setOwner(owner === "you" ? "agent" : "you")}
                  />
                }
              >
                {owner === "agent" ? <BotIcon /> : <UserIcon />}
              </TooltipTrigger>
              <TooltipPopup>
                {owner === "agent" ? "For the agent" : "For you"} · click to switch
              </TooltipPopup>
            </Tooltip>
            <Input
              ref={newItemRef}
              size="compact"
              aria-label="New todo"
              placeholder="Add a todo…"
              value={text}
              disabled={!canWrite || busy}
              onChange={(event) => setText(event.target.value)}
            />
            <Button
              type="submit"
              size="icon-sm"
              variant="ghost"
              aria-label="Add todo"
              disabled={!canWrite || busy || !text.trim()}
            >
              <PlusIcon />
            </Button>
          </div>
        </form>
      ) : null}
      {entry.summaryNotes ? (
        <section>
          <CollapsibleSectionHeader expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
            Notes
          </CollapsibleSectionHeader>
          {notesOpen ? (
            <p className="whitespace-pre-wrap px-2 pb-1 leading-5 text-muted-foreground">
              {entry.summaryNotes}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function TodoRow({
  crossThread,
  node,
  expanded,
  onExpandedChange,
  takeTextFocus,
  collapsed,
  onToggle,
  onAddChild,
  newItemRef,
  disabled,
  onChange,
  onMove,
  canIndent,
  canOutdent,
  onIndent,
  artifactCounts,
  artifactTitles,
  threadRef,
}: {
  crossThread: boolean;
  node: TodoNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** True once, for the row whose text keeps focus after Tab moved it. */
  takeTextFocus: () => boolean;
  collapsed: boolean;
  onToggle: () => void;
  onAddChild: (() => void) | undefined;
  newItemRef: React.RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onChange: (change: Omit<Change, "id">) => void;
  onMove?: ((direction: number) => void) | undefined;
  canIndent: boolean;
  canOutdent: boolean;
  onIndent: (direction: "in" | "out", draftText?: string | null) => boolean;
  artifactCounts: Map<string, number>;
  artifactTitles: Map<string, string>;
  threadRef: ScopedThreadRef;
}) {
  const { item, progress } = node;
  const focusNewItem = useRef(false);
  // Tab already wrote the text with the move, so the blur that follows must not write it again.
  const skipBlurSave = useRef(false);
  const [textRef] = useState(() => (input: HTMLInputElement | null) => {
    if (input && takeTextFocus()) input.focus();
  });
  const [details, setDetails] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const noteVisible = noteOpen || expanded;
  const terminal = item.state === "done" || item.state === "dropped";
  const openLink = listItemNeedsHandoff(item);
  const saveText = () => {
    if (skipBlurSave.current) skipBlurSave.current = false;
    else if (text?.trim() && text.trim() !== item.text) onChange({ text: text.trim() });
    setText(null);
  };
  const onTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key !== "Tab") return;
    if (onIndent(event.shiftKey ? "out" : "in", text ?? null)) {
      event.preventDefault();
      skipBlurSave.current = true;
      setText(null);
    }
  };
  return (
    <div className={cn("rounded-md hover:bg-muted/40", node.context && "opacity-60")}>
      <div className="flex min-w-0 items-start gap-1.5 py-1 pr-0.5">
        <Checkbox
          className="mt-0.5"
          aria-label={terminal ? `Reopen ${item.text}` : `Complete ${item.text}`}
          checked={terminal}
          disabled={disabled}
          onCheckedChange={() =>
            onChange({ state: terminal ? "open" : openLink ? "handed_off" : "done" })
          }
        />
        {item.details ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  variant="ghost"
                  size="micro"
                  aria-label={`Toggle note for ${item.text}`}
                  pressed={noteVisible}
                  onPressedChange={(next) => {
                    setNoteOpen(next);
                    if (!next) onExpandedChange(false);
                  }}
                />
              }
            >
              <NotebookTextIcon />
            </TooltipTrigger>
            <TooltipPopup>{noteVisible ? "Hide note" : "Show note"}</TooltipPopup>
          </Tooltip>
        ) : null}
        <div className="min-w-0 flex-1 leading-5">
          <button
            type="button"
            className={cn(
              "text-left break-words hover:underline",
              terminal && "text-muted-foreground line-through",
            )}
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            <OwnerIcon owner={item.owner} />
            {item.text}
          </button>
          {item.state === "dropped" ? (
            <span className="ml-1 text-3xs text-muted-foreground">dropped</span>
          ) : item.state === "handed_off" ? (
            <span className="ml-1 text-3xs text-muted-foreground">handed off</span>
          ) : null}
          {progress ? (
            <>
              <span className="ml-1 text-3xs tabular-nums text-muted-foreground">
                {progress.done}/{progress.total}
              </span>
              <Button
                variant="ghost"
                size="icon-tiny"
                className="align-middle"
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${item.text}`}
                aria-expanded={!collapsed}
                onClick={onToggle}
              >
                {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              </Button>
            </>
          ) : null}
          {item.links.map((link) => (
            <TodoLinkChip
              crossThread={crossThread}
              key={`${link.type}:${link.target}`}
              link={link}
              item={item}
              artifactCounts={artifactCounts}
              artifactTitles={artifactTitles}
              threadRef={threadRef}
            />
          ))}
        </div>
        <ItemTimestamp item={item} />
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="icon-tiny" aria-label={`Actions for ${item.text}`} />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup
            align="end"
            finalFocus={() => {
              if (!focusNewItem.current) return true;
              focusNewItem.current = false;
              newItemRef.current?.scrollIntoView({ block: "nearest" });
              return newItemRef.current;
            }}
          >
            <MenuItem onClick={() => onExpandedChange(true)}>
              {item.details ? "Edit note" : "Add note"}
            </MenuItem>
            <MenuItem
              disabled={disabled || !onAddChild}
              onClick={() => {
                focusNewItem.current = true;
                onAddChild?.();
              }}
            >
              Add sub-item
            </MenuItem>
            <MenuItem disabled={disabled || !canIndent} onClick={() => onIndent("in")}>
              Indent
            </MenuItem>
            <MenuItem disabled={disabled || !canOutdent} onClick={() => onIndent("out")}>
              Outdent
            </MenuItem>
            <MenuItem disabled={disabled || !onMove} onClick={() => onMove?.(-1)}>
              Move up
            </MenuItem>
            <MenuItem disabled={disabled || !onMove} onClick={() => onMove?.(1)}>
              Move down
            </MenuItem>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Responsible</MenuGroupLabel>
              <MenuRadioGroup
                value={item.owner}
                onValueChange={(next) => {
                  if ((next === "you" || next === "agent") && next !== item.owner)
                    onChange({ owner: next });
                }}
              >
                <MenuRadioItem value="you" disabled={disabled}>
                  <CheckedLabel>You</CheckedLabel>
                </MenuRadioItem>
                <MenuRadioItem value="agent" disabled={disabled}>
                  <CheckedLabel>Agent</CheckedLabel>
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem
              variant="switch"
              checked={item.needsQa}
              disabled={disabled}
              onCheckedChange={(needsQa) => onChange({ needsQa })}
            >
              Needs QA
            </MenuCheckboxItem>
            <MenuItem
              disabled={disabled}
              onClick={() => onChange({ state: terminal ? "open" : "dropped" })}
            >
              {terminal ? "Reopen" : "Drop"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {noteOpen && !expanded && item.details ? (
        <p className="whitespace-pre-wrap break-words pb-2 pl-5.5 pr-1 text-xs text-muted-foreground">
          {item.details}
        </p>
      ) : null}
      {expanded ? (
        <div className="space-y-1.5 pb-2 pl-5.5 pr-1">
          <Input
            ref={textRef}
            size="compact"
            aria-label={`Text for ${item.text}`}
            value={text ?? item.text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value.replace(/[\r\n]+/g, " "))}
            onKeyDown={onTextKeyDown}
            onBlur={saveText}
          />
          <Textarea
            size="sm"
            rows={2}
            aria-label={`Note for ${item.text}`}
            placeholder="Add a note…"
            value={details ?? item.details}
            disabled={disabled}
            onChange={(event) => setDetails(event.target.value)}
            onBlur={() => {
              if (details !== null && details !== item.details) onChange({ details });
              setDetails(null);
            }}
          />
          <p className="text-3xs text-muted-foreground">
            {item.doneAt ? "Completed" : "Added"}{" "}
            {new Date(item.doneAt ?? item.createdAt).toLocaleString()} · Tab indents, Shift+Tab
            outdents
          </p>
        </div>
      ) : null}
    </div>
  );
}

function OwnerIcon({ owner }: { owner: Owner }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "mr-1 inline-flex size-3.5 align-[-2px] [&_svg]:size-3.5",
              owner === "agent" ? "text-(--weavewing-yellow)" : "text-success-foreground",
            )}
            aria-label={ownerLabel(owner)}
            role="img"
          />
        }
      >
        {owner === "agent" ? <BotIcon /> : <UserIcon />}
      </TooltipTrigger>
      <TooltipPopup>{ownerLabel(owner)}</TooltipPopup>
    </Tooltip>
  );
}

function TodoLinkChip({
  crossThread,
  link,
  item,
  artifactCounts,
  artifactTitles,
  threadRef,
}: {
  crossThread: boolean;
  link: ListItem["links"][number];
  item: ListItem;
  artifactCounts: Map<string, number>;
  artifactTitles: Map<string, string>;
  threadRef: ScopedThreadRef;
}) {
  const state = item.linkStates?.find(
    (live) => live.type === link.type && live.target === link.target,
  );
  const label =
    (link.type === "artifact" ? artifactTitles.get(link.target) : undefined) ??
    (link.type === "ticket" ? link.target : state?.title) ??
    link.target;
  const count = link.type === "artifact" ? artifactCounts.get(link.target) : undefined;
  const status = state && link.type !== "artifact" ? state.label : null;
  const description = `${label}${status ? ` · ${status}` : ""}${count ? ` · ${count} unanswered` : ""}`;
  const content = (
    <span className="flex min-w-0 max-w-32 items-center gap-1">
      {link.type === "thread" && state?.state === "open" ? (
        <LoaderCircleIcon className="size-3" aria-label="Lane running" />
      ) : null}
      <span className="min-w-0 truncate">
        {label}
        {status ? ` · ${status}` : ""}
      </span>
      {count ? <span className="shrink-0">· {count}</span> : null}
    </span>
  );
  const chip =
    link.type === "artifact" ? (
      <Badge
        variant="outline"
        size="sm"
        render={
          <button
            type="button"
            aria-label={`Open artifact: ${description}`}
            onClick={() =>
              useThreadContextSidebarStore.getState().show("artifacts", {
                artifactId: link.target,
                // The QA view lists other threads, so their artifacts pin the sidebar to them.
                ...(crossThread ? { thread: threadRef } : { artifactThread: threadRef }),
              })
            }
          />
        }
      >
        {content}
      </Badge>
    ) : link.type === "thread" ? (
      <Badge
        variant="outline"
        size="sm"
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{
              environmentId: threadRef.environmentId,
              threadId: ThreadId.make(link.target),
            }}
          />
        }
      >
        {content}
      </Badge>
    ) : (
      <Badge
        variant="outline"
        size="sm"
        render={<a href={state?.url ?? link.target} target="_blank" rel="noreferrer" />}
      >
        {content}
      </Badge>
    );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ml-1 inline-flex align-middle" />}>
        {chip}
      </TooltipTrigger>
      <TooltipPopup>{description}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadListSummary({ threadRef }: { threadRef: ScopedThreadRef }) {
  const readable = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    readable
      ? threadListRead({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, all: true },
        })
      : null,
  );
  const entry = query.data?.[0];
  if (!entry?.items.length) return null;
  const next = entry.items.find((item) => item.state === "open")?.text ?? entry.summaryNotes;
  return (
    <button
      className="flex w-full min-w-0 gap-2 px-3 py-2 text-left text-xs hover:bg-muted"
      onClick={() => useThreadContextSidebarStore.getState().show("todos", { thread: threadRef })}
    >
      <span className="shrink-0">
        Todos · {entry.items.filter((item) => item.state === "done").length}/{entry.items.length}
      </span>
      <span className="truncate text-muted-foreground">· next: {next}</span>
    </button>
  );
}

export function YourQaView({ threadRef }: { threadRef: ScopedThreadRef }) {
  const readable = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    readable
      ? threadListRead({
          environmentId: threadRef.environmentId,
          input: { allThreads: true, all: true, needsQa: true },
        })
      : null,
  );
  return (
    <div className="overflow-y-auto p-3">
      <h2 className="text-sm font-medium">Needs your QA</h2>
      {query.error ? <p role="alert">{query.error}</p> : null}
      {query.data
        ?.filter((entry) => entry.items.length > 0)
        .map((entry) => (
          <section key={entry.threadId} className="border-b border-border py-2">
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: threadRef.environmentId, threadId: entry.threadId }}
              className="text-xs text-primary hover:underline"
            >
              {entry.threadTitle}
            </Link>
            <ThreadListView
              threadRef={{ ...threadRef, threadId: entry.threadId }}
              entry={entry}
              onRefresh={query.refresh}
            />
          </section>
        ))}
      {query.data?.every((entry) => entry.items.length === 0) ? (
        <p className="py-3 text-xs text-muted-foreground">Nothing needs your QA.</p>
      ) : null}
    </div>
  );
}

function ItemTimestamp({ item }: { item: ListItem }) {
  const nowMinute = useNowMinute();
  const timestamp = item.doneAt ?? item.createdAt;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={timestamp}
            className="hidden shrink-0 text-3xs text-muted-foreground @min-[320px]:inline"
          />
        }
      >
        {formatElapsedDurationLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`))}
      </TooltipTrigger>
      <TooltipPopup>{new Date(timestamp).toLocaleString()}</TooltipPopup>
    </Tooltip>
  );
}
