import { useAtomValue } from "@effect/atom-react";
import { maxNotificationSeverity } from "@t3tools/client-runtime/state/notifications";
import type { NotificationSeverity, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BellIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { shortcutLabelForCommand } from "../../../keybindings";
import { registerCommands } from "../../../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { useThreadContextSidebarStore } from "../../../threadContextSidebarStore";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { useToolSidebarStore } from "../../../toolSidebarStore";
import { SIDE_AREA_WIDE_MEDIA_QUERY } from "../../ToolSidebar.logic";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { SidebarMenuButton, useSidebar } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { WAITING_KIND_ICON } from "../WaitingItemsList";
import { WAITING_KIND_LABEL } from "../waitingStrip.logic";
import { registerWaitingListOpener } from "./waitingListCommand";
import { useWaitingOnYou } from "./waitingOnYou";
import {
  selectWaitingAlerts,
  waitingRowLabel,
  type WaitingAlert,
  type WaitingThread,
  type WaitingThreads,
} from "./waitingThreads.logic";

const ITEM = "[data-waiting-list-item]";

const UNREAD_BADGE: Record<NotificationSeverity, "error" | "warning" | "secondary"> = {
  critical: "error",
  warning: "warning",
  info: "secondary",
};

/**
 * "Waiting on you" at the top of the thread list: how many threads wait on the user, and a short
 * list of them with alerts no thread owns. It reads only what the client already streams.
 */
export function WaitingOnYouRow() {
  const { threads, inboxes, unread, visible } = useWaitingOnYou();
  const [open, setOpen] = useState(false);
  // Closing with nothing left keeps the list from reopening when something next waits.
  if (!visible && open) setOpen(false);
  const sidebar = useSidebar();
  const wide = useMediaQuery(SIDE_AREA_WIDE_MEDIA_QUERY);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "waiting.show");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const show = useStableCallback(() => {
    if (!visible) {
      toastManager.add({ type: "info", title: "Nothing is waiting on you", timeout: 2000 });
      return;
    }
    if (sidebar.isMobile) sidebar.setOpenMobile(true);
    else sidebar.setOpen(true);
    setOpen(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Holds the shortcut handler and the palette opener while the thread list is mounted.
  useEffect(() => {
    const stopOpener = registerWaitingListOpener(show);
    const stopCommands = registerCommands({
      "waiting.show": (event) => {
        event.preventDefault();
        event.stopPropagation();
        show();
      },
    });
    return () => {
      stopOpener();
      stopCommands();
    };
  }, [show]);

  if (!visible) return null;

  const waitingCount = threads.waiting.length;
  const severity = maxNotificationSeverity(
    inboxes.map((group) => group.inbox?.maxUnreadSeverity ?? null),
  );
  const label = waitingRowLabel(waitingCount, unread);
  const close = () => setOpen(false);
  const trigger = (
    <SidebarMenuButton
      ref={triggerRef}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-waiting-on-you-row
      onClick={wide ? undefined : () => setOpen(true)}
    >
      <UserRoundIcon />
      <span className="min-w-0 flex-1 truncate">Waiting on you</span>
      {unread > 0 ? (
        <Badge variant={UNREAD_BADGE[severity ?? "info"]} size="sm">
          <BellIcon aria-hidden />
          {unread}
        </Badge>
      ) : null}
      {waitingCount > 0 ? (
        <Badge variant="info" size="sm">
          {waitingCount}
        </Badge>
      ) : null}
    </SidebarMenuButton>
  );
  const list = (
    <WaitingList
      threads={threads}
      inboxes={inboxes}
      unread={unread}
      onDone={close}
      returnFocus={() => triggerRef.current?.focus({ preventScroll: true })}
    />
  );

  return (
    <div className="pt-1">
      {wide ? (
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
            <TooltipPopup side="right">
              {shortcut ? `What is waiting on you (${shortcut})` : "What is waiting on you"}
            </TooltipPopup>
          </Tooltip>
          <PopoverPopup
            side="right"
            align="start"
            width="md"
            padding="compact"
            initialFocus={firstItem}
          >
            {list}
          </PopoverPopup>
        </Popover>
      ) : (
        <>
          {trigger}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetPopup side="bottom" initialFocus={firstItem} finalFocus={triggerRef}>
              <SheetHeader>
                <SheetTitle>Waiting on you</SheetTitle>
              </SheetHeader>
              <div className="min-h-0 overflow-y-auto px-3 pb-4">{list}</div>
            </SheetPopup>
          </Sheet>
        </>
      )}
    </div>
  );
}

const firstItem = () => document.querySelector<HTMLElement>(ITEM) ?? true;

/** Arrow keys, Home and End move between the list's rows and its Open Inbox button. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM));
  if (items.length === 0) return;
  const index = items.findIndex((item) => item === document.activeElement);
  const next =
    event.key === "ArrowDown"
      ? items[(index + 1) % items.length]
      : event.key === "ArrowUp"
        ? items[(index - 1 + items.length) % items.length]
        : event.key === "Home"
          ? items[0]
          : event.key === "End"
            ? items.at(-1)
            : undefined;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function WaitingList({
  threads,
  inboxes,
  unread,
  onDone,
  returnFocus,
}: {
  threads: WaitingThreads;
  inboxes: ReturnType<typeof useWaitingOnYou>["inboxes"];
  unread: number;
  onDone: () => void;
  returnFocus: () => void;
}) {
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const now = Date.parse(`${useNowMinute()}Z`);
  const alerts = selectWaitingAlerts(
    inboxes.map((group) => ({
      environmentId: group.environment.environmentId,
      items: group.inbox?.items ?? [],
    })),
    now,
  );

  const openThread = (ref: ScopedThreadRef) => {
    onDone();
    if (sidebar.isMobile) sidebar.setOpenMobile(false);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  // Focus goes back to the row first, so closing the side panel later returns it there.
  const openInbox = (alert: WaitingAlert | null) => {
    onDone();
    if (sidebar.isMobile) sidebar.setOpenMobile(false);
    else returnFocus();
    const inbox = useThreadContextSidebarStore.getState();
    inbox.setInboxTab("inbox");
    if (alert) {
      inbox.selectInbox({
        kind: "notification",
        environmentId: alert.environmentId,
        id: alert.notification.id,
      });
    }
    useToolSidebarStore.getState().dispatch({ type: "show", view: "inbox" });
  };

  return (
    <div className="flex flex-col gap-2 py-1 text-sm" onKeyDown={moveFocus}>
      {threads.waiting.length > 0 ? (
        <Section
          title={`Waiting on you · ${threads.waiting.length} ${threads.waiting.length === 1 ? "thread" : "threads"}`}
        >
          {threads.waiting.map((thread) => (
            <ThreadEntry key={thread.key} thread={thread} onOpen={openThread} />
          ))}
        </Section>
      ) : null}
      {threads.onAgent.length > 0 ? (
        <Section title="Waiting on the agent" quiet>
          {threads.onAgent.map((thread) => (
            <ThreadEntry key={thread.key} thread={thread} quiet onOpen={openThread} />
          ))}
        </Section>
      ) : null}
      {alerts.length > 0 ? (
        <Section title="Alerts">
          {alerts.map((alert) => (
            <li key={`${alert.environmentId}:${alert.notification.id}`}>
              <button
                type="button"
                data-waiting-list-item=""
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={() => openInbox(alert)}
              >
                <span className="min-w-0 flex-1 break-words">{alert.notification.title}</span>
                {alert.notification.severity === "info" ? null : (
                  <Badge variant={UNREAD_BADGE[alert.notification.severity]} size="sm">
                    {alert.notification.severity}
                  </Badge>
                )}
              </button>
            </li>
          ))}
        </Section>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        data-waiting-list-item=""
        className="mx-2"
        onClick={() => openInbox(null)}
      >
        <BellIcon />
        Open Inbox
        {unread > 0 ? <span className="text-muted-foreground tabular-nums">{unread}</span> : null}
      </Button>
    </div>
  );
}

function Section({
  title,
  quiet = false,
  children,
}: {
  title: string;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h3
        className={
          quiet
            ? "px-2 pb-0.5 text-xs text-muted-foreground/80"
            : "px-2 pb-0.5 text-xs font-medium text-muted-foreground"
        }
      >
        {title}
      </h3>
      <ul>{children}</ul>
    </section>
  );
}

function ThreadEntry({
  thread,
  quiet = false,
  onOpen,
}: {
  thread: WaitingThread;
  quiet?: boolean;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  const spoken = [
    ...thread.counts.map(
      ({ kind, count }) =>
        `${count} ${count === 1 ? WAITING_KIND_LABEL[kind].one : WAITING_KIND_LABEL[kind].many}`,
    ),
    ...(thread.discussing > 0 ? [`${thread.discussing} discussing`] : []),
  ].join(", ");
  return (
    <li>
      <button
        type="button"
        data-waiting-list-item=""
        aria-label={`${thread.title}: ${spoken}`}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => onOpen(thread.ref)}
      >
        <span
          className={
            quiet
              ? "min-w-0 flex-1 break-words text-muted-foreground"
              : "min-w-0 flex-1 break-words"
          }
        >
          {thread.title}
        </span>
        {thread.counts.map(({ kind, count }) => {
          const Icon = WAITING_KIND_ICON[kind];
          return (
            <span
              key={kind}
              className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground tabular-nums"
            >
              <Icon aria-hidden className="size-3.5" />
              {count}
            </span>
          );
        })}
        {thread.discussing > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {thread.discussing} discussing
          </span>
        ) : null}
      </button>
    </li>
  );
}
