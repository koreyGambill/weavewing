import { useToolSidebarStore } from "../../../toolSidebarStore";
import { ViewCount, type ViewCountProps } from "../../../views/ViewCount";
import type { NotificationSeverity, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BellIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { cn } from "../../../lib/utils";
import { registerCommands } from "../../../shortcuts/dispatcher";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { SIDE_AREA_WIDE_MEDIA_QUERY } from "../../ToolSidebar.logic";
import { openInboxView } from "../../inbox/openInbox";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { SidebarMenuButton, useSidebar } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { WaitingAnswerIcon, WAITING_KIND_ICON } from "../waitingKindIcon";
import { WAITING_KIND_LABEL, trackedAnswerCountLabel } from "../waitingStrip.logic";
import { registerWaitingListOpener } from "./waitingListCommand";
import { useWaitingOnYou } from "./waitingOnYou";
import {
  selectWaitingAlerts,
  waitingListNote,
  waitingRowLabel,
  waitingShortcutAction,
  type WaitingAlert,
  type WaitingThread,
  type WaitingThreads,
} from "./waitingThreads.logic";

const ITEM = "[data-waiting-list-item]";

const UNREAD_TEXT: Record<NotificationSeverity, string> = {
  critical: "text-destructive-foreground",
  warning: "text-warning-foreground",
  info: "text-muted-foreground",
};

const SEVERITY_BADGE: Record<NotificationSeverity, "error" | "warning" | "secondary"> = {
  critical: "error",
  warning: "warning",
  info: "secondary",
};

/**
 * "Waiting on you" at the top of the thread list: how many threads wait on the user, and a short
 * list of them with alerts no thread owns. It reads only what the client already streams.
 */
export function WaitingOnYouRow() {
  const { threads, inboxes, unread, severity, machines, visible, enabledCount } = useWaitingOnYou();
  const [open, setOpen] = useState(false);
  // Closing with nothing left keeps the list from reopening when something next waits.
  if (!visible && open) setOpen(false);
  const sidebar = useSidebar();
  const wide = useMediaQuery(SIDE_AREA_WIDE_MEDIA_QUERY);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const show = useStableCallback((): boolean => {
    if (wide && visible) {
      openWaitingView();
      return true;
    }
    const row = triggerRef.current;
    if (!visible || row === null || !row.checkVisibility()) return false;
    if (sidebar.isMobile) {
      if (!sidebar.openMobile) return false;
    } else {
      sidebar.setOpen(true);
    }
    setOpen(true);
    return true;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Holds the shortcut handler and the palette opener while the thread list is mounted.
  useEffect(() => {
    const stopOpener = registerWaitingListOpener(show);
    const stopCommands = registerCommands({
      "waiting.show": (event) => {
        const action = waitingShortcutAction(enabledCount, visible);
        if (action === "off") return false;
        event.preventDefault();
        event.stopPropagation();
        if (action === "empty") {
          toastManager.add({ type: "info", title: "Nothing is waiting on you", timeout: 2000 });
        } else if (!show()) {
          openWaitingView();
        }
      },
    });
    return () => {
      stopOpener();
      stopCommands();
    };
  }, [show, visible, enabledCount]);

  if (wide || !visible) return null;

  const waitingCount = threads.waiting.length;
  const label = waitingRowLabel(waitingCount, unread);
  const close = () => setOpen(false);
  const trigger = (
    <SidebarMenuButton
      ref={triggerRef}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-waiting-on-you-row
      onClick={() => setOpen(true)}
    >
      <UserRoundIcon />
      <span className="min-w-0 flex-1 truncate text-sidebar-foreground">Waiting on you</span>
      <span className="flex shrink-0 items-center gap-1">
        {unread > 0 ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
              UNREAD_TEXT[severity ?? "info"],
            )}
          >
            <BellIcon aria-hidden className="size-3" />
            {unread}
          </span>
        ) : null}
        {waitingCount > 0 ? (
          <Badge variant="info" size="sm">
            {waitingCount}
          </Badge>
        ) : null}
      </span>
    </SidebarMenuButton>
  );
  const list = (
    <WaitingList
      threads={threads}
      inboxes={inboxes}
      unread={unread}
      machines={machines}
      onDone={close}
      returnFocus={() => triggerRef.current?.focus({ preventScroll: true })}
    />
  );

  return (
    <div className="pt-1">
      {trigger}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup
          ref={sheetRef}
          side="bottom"
          initialFocus={() => sheetRef.current?.querySelector<HTMLElement>(ITEM) ?? true}
          finalFocus={triggerRef}
        >
          <SheetHeader>
            <SheetTitle>Waiting on you</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-3 pb-4">{list}</div>
        </SheetPopup>
      </Sheet>
    </div>
  );
}

export function openWaitingView() {
  useToolSidebarStore.getState().dispatch({ type: "show", view: "waiting" });
}

export function WaitingOnYouCount({ mark }: ViewCountProps) {
  const { threads, inboxes } = useWaitingOnYou();
  const now = Date.parse(`${useNowMinute()}Z`);
  if (selectWaitingAlerts(inboxes, now).length > 0) {
    return (
      <ViewCount mark={mark} alert>
        Alerts
      </ViewCount>
    );
  }
  return threads.waiting.length > 0 ? (
    <ViewCount mark={mark}>{threads.waiting.length}</ViewCount>
  ) : null;
}

export function WaitingOnYouView() {
  const { threads, inboxes, unread, machines } = useWaitingOnYou();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
      <WaitingList threads={threads} inboxes={inboxes} unread={unread} machines={machines} />
    </div>
  );
}

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
  machines,
  onDone,
  returnFocus,
}: {
  threads: WaitingThreads;
  inboxes: ReturnType<typeof useWaitingOnYou>["inboxes"];
  unread: number;
  machines: ReturnType<typeof useWaitingOnYou>["machines"];
  onDone?: () => void;
  returnFocus?: () => void;
}) {
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const now = Date.parse(`${useNowMinute()}Z`);
  const alerts = selectWaitingAlerts(inboxes, now);
  const note = waitingListNote(threads, alerts.length, unread);

  const openThread = (ref: ScopedThreadRef) => {
    onDone?.();
    if (sidebar.isMobile) sidebar.setOpenMobile(false);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  // Focus goes back to the row first, so closing the side panel later returns it there.
  const openInbox = (alert: WaitingAlert | null) => {
    onDone?.();
    if (sidebar.isMobile) sidebar.setOpenMobile(false);
    else returnFocus?.();
    openInboxView(
      alert ? { environmentId: alert.environmentId, id: alert.notification.id } : undefined,
    );
  };

  return (
    <div className="flex flex-col gap-2 py-1 text-sm" onKeyDown={moveFocus}>
      <WaitingAlerts alerts={alerts} onOpen={openInbox} />
      {threads.waiting.length > 0 ? (
        <Section title={`Threads · ${threads.waiting.length}`}>
          {threads.waiting.map((thread) => (
            <ThreadEntry
              key={thread.key}
              thread={thread}
              machine={machines?.get(thread.ref.environmentId) ?? null}
              onOpen={openThread}
            />
          ))}
        </Section>
      ) : null}
      {threads.onAgent.length > 0 ? (
        <Section title="Waiting on the agent" quiet>
          {threads.onAgent.map((thread) => (
            <ThreadEntry
              key={thread.key}
              thread={thread}
              machine={machines?.get(thread.ref.environmentId) ?? null}
              quiet
              onOpen={openThread}
            />
          ))}
        </Section>
      ) : null}
      {note ? <p className="px-2 text-muted-foreground">{note}</p> : null}
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

function WaitingAlerts({
  alerts,
  onOpen,
}: {
  alerts: ReadonlyArray<WaitingAlert>;
  onOpen: (alert: WaitingAlert) => void;
}) {
  return alerts.length > 0 ? (
    <Section title="Alerts">
      {alerts.map((alert) => (
        <li key={`${alert.environmentId}:${alert.notification.id}`}>
          <button
            type="button"
            data-waiting-list-item=""
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => onOpen(alert)}
          >
            <span className="min-w-0 flex-1 break-words">{alert.notification.title}</span>
            {alert.notification.severity === "info" ? null : (
              <Badge variant={SEVERITY_BADGE[alert.notification.severity]} size="sm">
                {alert.notification.severity}
              </Badge>
            )}
          </button>
        </li>
      ))}
    </Section>
  ) : null;
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
  machine,
  quiet = false,
  onOpen,
}: {
  thread: WaitingThread;
  /** Shown beside the title while more than one machine is connected. */
  machine: string | null;
  quiet?: boolean;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  const spoken = [
    ...thread.counts.map(
      ({ kind, count }) =>
        `${count} ${count === 1 ? WAITING_KIND_LABEL[kind].one : WAITING_KIND_LABEL[kind].many}`,
    ),
    ...(thread.discussing > 0 ? [`${thread.discussing} discussing`] : []),
    ...(thread.answersToRead ? [trackedAnswerCountLabel(thread.answersToRead, "to read")] : []),
    ...(thread.owedAnswers ? [trackedAnswerCountLabel(thread.owedAnswers, "owed")] : []),
  ].join(", ");
  return (
    <li>
      <button
        type="button"
        data-waiting-list-item=""
        aria-label={`${thread.title}${machine ? ` on ${machine}` : ""}: ${spoken}`}
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
          {machine ? <span className="text-xs text-muted-foreground"> · {machine}</span> : null}
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
        {thread.answersToRead ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground tabular-nums">
            <WaitingAnswerIcon aria-hidden="true" className="size-3.5" />
            {thread.answersToRead}
          </span>
        ) : null}
        {thread.owedAnswers ? (
          <span className="shrink-0 text-xs text-muted-foreground">{thread.owedAnswers} owed</span>
        ) : null}
      </button>
    </li>
  );
}
