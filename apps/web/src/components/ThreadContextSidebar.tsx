import { useOpenFollowUpCount } from "./reviews/FollowUps";
import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  BellIcon,
  InfoIcon,
  MessagesSquareIcon,
  PinIcon,
  PinOffIcon,
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
import { useRouteDraft, useThreadToolsSlots, useThreadToolsTarget } from "./threadToolsHost";
import { useEvidenceEnvironment, useReloadEvidenceOnReturn } from "../state/evidence";
import { useInboxSignal } from "../state/inbox";
import { sidebarWorkspaceGet } from "../state/threadWorkspace";
import { viewDefinition } from "../views/viewRegistry";
import { ThreadViewBody } from "../views/ThreadViewBody";
import { Button } from "./ui/button";
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

const INBOX_TOOL = {
  title: "Inbox",
  icon: BellIcon,
  about:
    "Urgent problems and important things you must not miss. Snooze or dismiss one to clear it; the Snoozed and Dismissed tabs bring it back.",
};

function tool(view: ThreadContextSection): { title: string; icon: LucideIcon; about: string } {
  return view === "inbox" ? INBOX_TOOL : viewDefinition(view);
}

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
  const draft = useRouteDraft(threadRef);
  const { actions, setDetails } = useThreadToolsSlots();
  return (
    <div className="flex min-h-0 flex-1">
      <ThreadToolsStrip threadRef={threadRef} />
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view !== "threads" && "hidden")}>
        {children}
      </div>
      {view !== "threads" && visible ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ThreadToolHeading view={view} />
          <ThreadViewBody
            key={
              threadRef && view !== "inbox" && view !== "evidence"
                ? `${threadRef.environmentId}:${threadRef.threadId}:${view}`
                : view
            }
            view={view}
            title={tool(view).title}
            target={{ threadRef, draft }}
            slots={{ actions, setDetails }}
          />
        </div>
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
        { capture: true },
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

/** A tool view's heading row: its title and about note, then its own buttons and the pin. */
function ThreadToolHeading({ view }: { view: ThreadContextSection }) {
  const { setActions } = useThreadToolsSlots();
  const pinned = useThreadContextSidebarStore((state) => state.pinned);
  const threadRef = useThreadToolsTarget();
  const shell = useThreadShell(threadRef);
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 px-2 pt-2">
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{tool(view).title}</h2>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="icon-xs" aria-label={`About ${tool(view).title}`} />
          }
        >
          <InfoIcon />
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="start">
          <p className="max-w-64 text-xs leading-5">{tool(view).about}</p>
        </PopoverPopup>
      </Popover>
      <div ref={setActions} className="ml-auto flex shrink-0 items-center" />
      {threadRef && view !== "inbox" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
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
    </div>
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
  const inbox = useInboxSignal();
  return threadToolsAttention(signals, inbox);
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
        ]
          .filter(Boolean)
          .join(", ") || undefined
      }
      icon={BellIcon}
    >
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
  const openFollowUps = useOpenFollowUpCount(threadRef);
  useReloadEvidenceOnReturn(useEvidenceEnvironment(threadRef) !== null);
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
        const { title, icon } = tool(id);
        const count =
          id === "todos"
            ? signals.listCount + openFollowUps
            : id === "artifacts"
              ? signals.questionCount
              : 0;
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
                  {tool(item).title}
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
