import { useAtomValue } from "@effect/atom-react";
import { Link, useParams } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  BellIcon,
  BoxesIcon,
  CalendarClockIcon,
  FilesIcon,
  IdCardIcon,
  InfoIcon,
  LinkIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  NetworkIcon,
  ChartGanttIcon,
  PinIcon,
  PinOffIcon,
  ScanSearchIcon,
  Settings2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { registerCommands } from "../shortcuts/dispatcher";
import { useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import {
  summarizeThreadTools,
  THREAD_TOOL_ORDER,
  threadToolsAttention,
  type ThreadToolsAttentionTone,
} from "../threadContextSidebar";
import {
  useThreadContextSidebarStore,
  type SidebarView,
  type StripItem,
  type ThreadContextSection,
} from "../threadContextSidebarStore";
import {
  useSidebarHeaderOnBackdrop,
  useThreadToolsSlots,
  useThreadToolsTarget,
} from "./threadToolsHost";
import { useStatusSignal } from "./statusSources/StatusSources";
import { InboxView } from "./inbox/InboxView";
import { StatusSourceDot } from "./statusSources/StatusSourceIcon";
import { useInboxSignal } from "../state/inbox";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  FLUSH_THREAD_TOOLS,
  sidebarWorkspaceGet,
  ThreadInspect,
  ThreadToolSection,
} from "./ThreadToolViews";
import { Button } from "./ui/button";
import { Empty, EmptyDescription } from "./ui/empty";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { useSidebar, useSidebarVisibility } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WeavewingMark } from "./WeavewingMark";
import { AutomationsView } from "./automations/AutomationsView";

const tools: Record<ThreadContextSection, { title: string; icon: LucideIcon; about: string }> = {
  todos: {
    title: "Todos",
    icon: ListChecksIcon,
    about:
      "Commitments agents and you track for this thread. Agents update it with list_update; you can add and check items here.",
  },
  artifacts: {
    title: "Artifacts",
    icon: FilesIcon,
    about:
      "Documents and pages agents publish for this thread, with any questions they ask you. Agents write them with artifact_write; you answer here.",
  },
  links: {
    title: "Links",
    icon: LinkIcon,
    about:
      "The thread's ticket and pull requests, then web links found in the conversation. It fills as agents link work and post URLs.",
  },
  related: {
    title: "Related",
    icon: NetworkIcon,
    about:
      "Threads this one delegated to, forked, messaged or heard from. Agent suggestions will appear under Suggested.",
  },
  timeline: {
    title: "Timeline",
    icon: ChartGanttIcon,
    about:
      "When this thread and its delegates ran, one row per thread on a shared clock. Hover a bar for its model and timing; click it to open that thread.",
  },
  details: {
    title: "Details",
    icon: IdCardIcon,
    about:
      "The conversation's details card: workspace, branch, scripts and automations. It is the same card the thread view shows.",
  },
  environments: {
    title: "Environments",
    icon: BoxesIcon,
    about:
      "Where this thread's code lives: the Xwing environments it and its delegated work use, or else its worktree and branch.",
  },
  inbox: {
    title: "Inbox",
    icon: BellIcon,
    about:
      "Notifications from automations and agents, plus status sources. Snooze or dismiss one to clear it; the Snoozed and Dismissed tabs bring it back.",
  },
  inspect: {
    title: "Inspect",
    icon: ScanSearchIcon,
    about:
      "What the agent loaded and spent: file and skill reads, context per turn, and tokens. T3 records it as turns run.",
  },
  automations: {
    title: "Automations",
    icon: CalendarClockIcon,
    about:
      "Agents that run on a schedule, a webhook or an event. Switch them on or off for this thread, the project or the whole server, and open a run's thread from its history.",
  },
};

function useThreadToolSignals(threadRef: ScopedThreadRef | null) {
  const canRead = useEnvironmentScope(threadRef?.environmentId ?? null, AuthOrchestrationReadScope);
  const workspace = useEnvironmentQuery(
    threadRef && canRead
      ? sidebarWorkspaceGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  return summarizeThreadTools(workspace.data ?? null);
}

/** The activity strip beside the left sidebar's content, swapping the thread list for a tool view. */
export function ThreadToolsFrame({ children }: { children: ReactNode }) {
  const threadRef = useThreadToolsTarget();
  const view = useThreadContextSidebarStore((state) => state.view);
  const visible = useSidebarVisibility();
  return (
    <div className="flex min-h-0 flex-1">
      <ThreadToolsStrip threadRef={threadRef} />
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view !== "threads" && "hidden")}>
        {children}
      </div>
      {view !== "threads" && visible ? (
        <ThreadToolView
          key={
            threadRef && view !== "inbox"
              ? `${threadRef.environmentId}:${threadRef.threadId}:${view}`
              : view
          }
          view={view}
          threadRef={threadRef}
        />
      ) : null}
      <ThreadToolsCommands />
    </div>
  );
}

function ThreadToolsCommands() {
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const visible = isMobile ? openMobile : open;
  const revealPending = useThreadContextSidebarStore((state) => state.revealPending);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The shortcut needs the sidebar's current visibility to decide between opening and flipping views.
  useEffect(
    () =>
      registerCommands(
        {
          "threadContext.toggle": (event) => {
            event.preventDefault();
            useThreadContextSidebarStore.getState().toggleTools(visible);
          },
        },
        {
          capture: true,
          when: (event) =>
            !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]")),
        },
      ),
    [visible],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tool requests from outside the sidebar (palette, todo summary, shortcut) open the sidebar's own store.
  useEffect(() => {
    if (!revealPending) return;
    useThreadContextSidebarStore.getState().consumeReveal();
    if (isMobile) setOpenMobile(true);
    else setOpen(true);
  }, [revealPending, isMobile, setOpen, setOpenMobile]);
  return null;
}

function useShortcutTooltip() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "threadContext.toggle");
  const view = useThreadContextSidebarStore((state) => state.view);
  const lastTool = useThreadContextSidebarStore((state) => state.lastTool);
  // The shortcut flips to whichever view this names, so its tooltip carries the label.
  const shortcutTarget: SidebarView = view === "threads" ? lastTool : "threads";
  return (id: SidebarView, title: string) =>
    `${title}${shortcut && shortcutTarget === id ? ` · ${shortcut}` : ""}`;
}

/** The header's lockup: the mark opens the thread list, then the wordmark or the open tool's title. */
export function ThreadToolsBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const view = useThreadContextSidebarStore((state) => state.view);
  const tooltip = useShortcutTooltip();
  return (
    <div className="flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag] md:ml-[calc(var(--workspace-titlebar-content-left)-0.5rem)]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={onBackdrop ? "media-navigation" : "ghost"}
              size="icon-sm"
              className={onBackdrop ? "relative top-auto translate-y-0" : undefined}
              aria-label="Thread list"
              onClick={() => useThreadContextSidebarStore.getState().selectView("threads")}
            />
          }
        >
          <WeavewingMark
            aria-hidden
            // The mark's thin green and yellow strokes vanish on the light backdrop without a tile.
            className={cn("size-5", onBackdrop && "rounded-md bg-background/85 p-0.5")}
          />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tooltip("threads", "Thread list")}</TooltipPopup>
      </Tooltip>
      {view === "threads" ? (
        <Link
          to="/"
          aria-label="Weavewing home"
          className="shrink-0 rounded-md text-sm font-medium tracking-tight outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        >
          <span className={onBackdrop ? "text-white/70" : "text-muted-foreground"}>weave</span>
          <span className="text-(--weavewing-yellow)">wing</span>
        </Link>
      ) : (
        <>
          <h2
            className={cn(
              "min-w-0 truncate text-sm font-medium",
              onBackdrop ? "text-white" : "text-foreground",
            )}
          >
            {tools[view].title}
          </h2>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant={onBackdrop ? "media-navigation" : "ghost"}
                  size="icon-xs"
                  className={onBackdrop ? "relative top-auto translate-y-0" : undefined}
                  aria-label={`About ${tools[view].title}`}
                />
              }
            >
              <InfoIcon />
            </PopoverTrigger>
            <PopoverPopup side="bottom" align="start">
              <p className="max-w-64 text-xs leading-5">{tools[view].about}</p>
            </PopoverPopup>
          </Popover>
        </>
      )}
    </div>
  );
}

/** The header's right end: navigation on the thread list, the open tool's own buttons otherwise. */
export function ThreadToolsHeaderEnd({ children }: { children: ReactNode }) {
  const onBackdrop = useSidebarHeaderOnBackdrop();
  const { setActions } = useThreadToolsSlots();
  const view = useThreadContextSidebarStore((state) => state.view);
  const pinned = useThreadContextSidebarStore((state) => state.pinned);
  const threadRef = useThreadToolsTarget();
  const shell = useThreadShell(threadRef);
  if (view === "threads") return children;
  return (
    <>
      <div ref={setActions} className="flex items-center" />
      {threadRef && view !== "inbox" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={onBackdrop ? "media-navigation" : "ghost"}
                size="icon-sm"
                className={onBackdrop ? "relative top-auto translate-y-0" : undefined}
                aria-label={pinned ? "Unpin thread tools" : "Pin thread tools"}
                aria-pressed={pinned !== null}
                onClick={() =>
                  useThreadContextSidebarStore.getState().pin(pinned ? null : threadRef)
                }
              />
            }
          >
            {pinned ? <PinOffIcon /> : <PinIcon />}
          </TooltipTrigger>
          <TooltipPopup>
            {pinned
              ? `Pinned to ${shell?.title ?? "this thread"} · follow the focused tile`
              : `Showing ${shell?.title ?? "the focused tile"} · pin this thread`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}

const attentionToneClass: Record<ThreadToolsAttentionTone, string> = {
  alert: "bg-destructive",
  question: "bg-primary",
  warn: "bg-warning",
  review: "bg-info",
  todo: "bg-muted-foreground",
};

/** What the hidden sidebar would flag, for the sidebar toggle. */
export function useThreadToolsAttention() {
  const signals = useThreadToolSignals(useThreadToolsTarget());
  const { state } = useStatusSignal();
  const inbox = useInboxSignal();
  return threadToolsAttention(signals, state, inbox);
}

export function ThreadToolsAttentionDot({ tone }: { tone: ThreadToolsAttentionTone }) {
  return (
    <span
      aria-hidden
      data-attention={tone}
      className={cn(
        "pointer-events-none absolute left-[calc(var(--workspace-titlebar-control-size)-0.375rem)] top-[calc(50%-var(--workspace-titlebar-control-size)/2)] size-2 rounded-full ring-2 ring-background",
        attentionToneClass[tone],
      )}
    />
  );
}

const inboxBadgeClass = {
  critical: "bg-destructive text-white",
  warning: "bg-warning text-black",
  info: "bg-muted-foreground text-sidebar",
} as const;

function InboxStripButton({ active, tooltip }: { active: boolean; tooltip: string }) {
  const { unread, severity, failed } = useInboxSignal();
  const { state } = useStatusSignal();
  const statusAlert = state === "fail" || state === "warn" ? state : null;
  return (
    <StripButton
      id="inbox"
      title="Inbox"
      active={active}
      tooltip={tooltip}
      badge={
        [
          unread ? `${unread} unread${severity && severity !== "info" ? `, ${severity}` : ""}` : "",
          failed ? "notifications unavailable" : "",
          statusAlert ? `status ${statusAlert === "fail" ? "failing" : "warning"}` : "",
        ]
          .filter(Boolean)
          .join(", ") || undefined
      }
      icon={BellIcon}
    >
      {statusAlert ? (
        <span className="pointer-events-none absolute right-0 bottom-0 flex rounded-full bg-sidebar p-px">
          <StatusSourceDot state={statusAlert} />
        </span>
      ) : null}
      {failed && !unread ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-1 -top-1 min-w-3.5 rounded-full bg-muted-foreground px-1 text-center text-3xs leading-3.5 font-medium text-sidebar ring-2 ring-sidebar"
        >
          !
        </span>
      ) : unread ? (
        <span
          aria-hidden
          data-severity={severity}
          className={cn(
            "pointer-events-none absolute -right-1 -top-1 min-w-3.5 rounded-full px-1 text-center text-3xs leading-3.5 font-medium ring-2 ring-sidebar",
            inboxBadgeClass[severity ?? "info"],
          )}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </StripButton>
  );
}

const STRIP_ITEMS: ReadonlyArray<StripItem> = ["inbox", ...THREAD_TOOL_ORDER];

function ThreadToolsStrip({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const view = useThreadContextSidebarStore((state) => state.view);
  const hidden = useThreadContextSidebarStore((state) => state.hidden);
  const signals = useThreadToolSignals(threadRef);
  const tooltip = useShortcutTooltip();
  const visibleTools = THREAD_TOOL_ORDER.filter((id) => !hidden.includes(id));
  return (
    <nav
      aria-label="Sidebar views"
      className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-sidebar-border py-2 [-webkit-app-region:no-drag] [scrollbar-width:none]"
    >
      <StripButton
        id="threads"
        title="Threads"
        active={view === "threads"}
        tooltip={tooltip("threads", "Threads")}
        icon={MessagesSquareIcon}
      />
      {hidden.includes("inbox") ? null : (
        <InboxStripButton active={view === "inbox"} tooltip={tooltip("inbox", "Inbox")} />
      )}
      {visibleTools.length ? (
        <span aria-hidden className="my-0.5 h-px w-5 shrink-0 bg-sidebar-border" />
      ) : null}
      {visibleTools.map((id) => {
        const { title, icon } = tools[id];
        const count =
          id === "todos" ? signals.listCount : id === "artifacts" ? signals.questionCount : 0;
        const ticket = id === "links" ? signals.ticketState : null;
        return (
          <StripButton
            key={id}
            id={id}
            title={title}
            active={view === id}
            tooltip={tooltip(id, title)}
            badge={
              count
                ? `${count} ${id === "todos" ? "open" : "unanswered"}`
                : ticket
                  ? `ticket ${ticket.replace("_", " ")}`
                  : undefined
            }
            icon={icon}
          >
            {ticket ? (
              <span
                className={cn(
                  "pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full ring-2 ring-sidebar",
                  ticket === "closed" ? "bg-success" : "bg-info",
                )}
              />
            ) : null}
            {count ? (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute -right-1 -top-1 min-w-3.5 rounded-full px-1 text-center text-3xs leading-3.5 font-medium ring-2 ring-sidebar",
                  id === "artifacts"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted-foreground text-sidebar",
                )}
              >
                {count > 99 ? "99+" : count}
              </span>
            ) : null}
          </StripButton>
        );
      })}
      <div className="mt-auto pt-1">
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label="Choose sidebar views" />
                  }
                />
              }
            >
              <Settings2Icon />
            </TooltipTrigger>
            <TooltipPopup side="right">Choose sidebar views</TooltipPopup>
          </Tooltip>
          <MenuPopup side="right" align="end">
            <MenuGroup>
              <MenuGroupLabel>Show in the strip</MenuGroupLabel>
              {STRIP_ITEMS.map((item) => (
                <MenuCheckboxItem
                  key={item}
                  checked={!hidden.includes(item)}
                  onCheckedChange={(checked) =>
                    useThreadContextSidebarStore.getState().setHidden(item, !checked)
                  }
                >
                  {tools[item].title}
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </div>
    </nav>
  );
}

function StripButton({
  icon: Icon,
  ...props
}: {
  id: SidebarView;
  title: string;
  icon: LucideIcon;
  active: boolean;
  tooltip: string;
  badge?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="relative">
      {props.active ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1 -left-2 w-0.5 rounded-full bg-success-foreground"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={props.active ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={`${props.title}${props.badge ? `, ${props.badge}` : ""}`}
              aria-pressed={props.active}
              onClick={() => useThreadContextSidebarStore.getState().selectView(props.id)}
            />
          }
        >
          <Icon className={props.active ? "text-success-foreground" : undefined} />
        </TooltipTrigger>
        <TooltipPopup side="right">{props.tooltip}</TooltipPopup>
      </Tooltip>
      {props.children}
    </div>
  );
}

function ThreadToolView({
  view,
  threadRef,
}: {
  view: ThreadContextSection;
  threadRef: ScopedThreadRef | null;
}) {
  const { actions, setDetails } = useThreadToolsSlots();
  const { title } = tools[view];
  // Inspect previews a draft's default context before its first message.
  const { draftId: routeDraftId } = useParams({ strict: false });
  const draftId = routeDraftId === undefined ? undefined : DraftId.make(routeDraftId);
  const draftSession = useComposerDraftStore((store) =>
    threadRef === null && draftId ? store.getDraftSession(draftId) : null,
  );
  const draft = draftId && draftSession ? { draftId, session: draftSession } : null;
  return (
    <section
      aria-label={title}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        view !== "inbox" && !FLUSH_THREAD_TOOLS.has(view) && "overflow-auto px-2.5 py-2.5",
      )}
    >
      {view === "inbox" ? (
        <InboxView actions={actions} />
      ) : view === "automations" ? (
        <AutomationsView threadRef={threadRef} />
      ) : threadRef ? (
        <ThreadToolSection
          section={view}
          threadRef={threadRef}
          detailsRef={setDetails}
          actions={actions}
        />
      ) : view === "inspect" && draft ? (
        <ThreadInspect
          threadRef={scopeThreadRef(draft.session.environmentId, draft.session.threadId)}
          draftId={draft.draftId}
        />
      ) : (
        <Empty size="compact">
          <EmptyDescription>Open a thread to see its {title.toLowerCase()}.</EmptyDescription>
        </Empty>
      )}
    </section>
  );
}
