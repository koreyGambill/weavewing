import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type Notification,
  type NotificationAction,
  type NotificationSeverity,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import { notificationTab, type NotificationTab } from "@t3tools/client-runtime/state/notifications";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  CheckCheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MailIcon,
  MailOpenIcon,
  MessageSquareIcon,
  Settings2Icon,
} from "lucide-react";
import { memo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal, flushSync } from "react-dom";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { useInboxEnvironments } from "../../state/inbox";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { type InboxTab, useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import ChatMarkdown from "../ChatMarkdown";
import { useScheduledTaskTitle } from "../chat/TimelineUserMessageRow";
import { RelativeTime } from "../RelativeTime";
import { StatusSourceDot } from "../statusSources/StatusSourceIcon";
import { StatusSourcesList, useStatusSignal } from "../statusSources/StatusSources";
import { ToolHeaderButton } from "../threadToolsHost";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface InboxItem {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly notification: Notification;
}

const SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 60 },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "after", minutes: 7 * 24 * 60 },
];

const TABS: ReadonlyArray<{ id: InboxTab; label: string; icon: ReactNode }> = [
  { id: "inbox", label: "Inbox", icon: <BellIcon /> },
  { id: "snoozed", label: "Snoozed", icon: <AlarmClockIcon /> },
  { id: "dismissed", label: "Dismissed", icon: <ArchiveIcon /> },
];

const severityLabel: Record<NotificationSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

const severityBar: Record<NotificationSeverity, string | null> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: null,
};

const rowKey = (environmentId: string, id: string) => `${environmentId}:${id}`;

function useNotificationActions(environmentId: EnvironmentId) {
  const permitted = useAtomValue(
    serverEnvironment.updateNotifications.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateNotifications);
  return {
    permitted,
    run: (notification: Notification, action: NotificationAction) =>
      void update({ environmentId, input: { ids: [notification.id], action } }),
  };
}

function SnoozeMenu({
  disabled,
  compact,
  onSnooze,
  onOpenChange,
}: {
  disabled: boolean;
  compact?: boolean;
  /** Returns where focus goes once the snoozed item leaves its place. */
  onSnooze: (until: string) => HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
}) {
  const finalFocus = useRef<HTMLElement | null>(null);
  const [presets, setPresets] = useState<ReturnType<typeof resolveSnoozePresets>>([]);
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) setPresets(resolveSnoozePresets(new Date(), { presets: SNOOZE_PRESETS }));
        onOpenChange?.(open);
      }}
    >
      {compact ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button variant="ghost" size="icon-xs" aria-label="Snooze" disabled={disabled} />
                }
              />
            }
          >
            <AlarmClockIcon />
          </TooltipTrigger>
          <TooltipPopup>Snooze</TooltipPopup>
        </Tooltip>
      ) : (
        <MenuTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
          <AlarmClockIcon />
          Snooze
        </MenuTrigger>
      )}
      <MenuPopup align="end" finalFocus={() => finalFocus.current ?? true}>
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() => {
              finalFocus.current = onSnooze(preset.snoozedUntil);
            }}
          >
            <span className="flex-1">{preset.label}</span>
            <span className="text-muted-foreground">{preset.whenLabel}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function IconAction(props: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** What raised the notification: the automation's title, or the agent thread's. */
function useSourceLabel(environmentId: EnvironmentId, notification: Notification): string {
  const { source } = notification;
  const taskId: ScheduledTaskId | undefined =
    source.kind === "agent" ? undefined : source.scheduledTaskId;
  const taskTitle = useScheduledTaskTitle(environmentId, taskId);
  const shell = useThreadShell(
    source.kind === "agent" ? scopeThreadRef(environmentId, source.threadId) : null,
  );
  if (source.kind === "agent") return `Agent · ${shell?.title ?? "thread"}`;
  return taskTitle ?? (source.kind === "review" ? "Review" : "Automation");
}

function VerificationChip({ notification }: { notification: Notification }) {
  const verification = notification.verification;
  if (!verification || verification.status === "pending" || verification.status === "rejected")
    return null;
  const model = verification.model?.model;
  return verification.status === "confirmed" ? (
    <Badge variant="success" size="sm">
      Verified{model ? ` · ${model}` : ""}
    </Badge>
  ) : (
    <Badge variant="outline" size="sm">
      Unverified
    </Badge>
  );
}

// Props stay primitive or fold-stable so an upsert re-renders only the rows it changed.
const InboxRow = memo(function InboxRow({
  notification,
  environmentId,
  environmentLabel,
  tab,
}: {
  notification: Notification;
  environmentId: EnvironmentId;
  environmentLabel: string | null;
  tab: NotificationTab;
}) {
  const actions = useNotificationActions(environmentId);
  const source = useSourceLabel(environmentId, notification);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const unread = notification.readAt === null;
  const bar = severityBar[notification.severity];
  const itemRef = useRef<HTMLLIElement>(null);
  const open = () => {
    useThreadContextSidebarStore
      .getState()
      .selectInbox({ kind: "notification", environmentId, id: notification.id });
    if (unread && actions.permitted) actions.run(notification, { type: "read" });
  };
  // The row leaves this tab, so focus moves to a neighbour, or the tabs for the last row.
  const leave = (action: NotificationAction) => {
    const item = itemRef.current;
    const target =
      (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector<HTMLElement>(
        "[data-inbox-row]",
      ) ??
      item?.closest("[data-inbox-root]")?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
      null;
    target?.focus();
    actions.run(notification, action);
    return target;
  };
  return (
    <li
      ref={itemRef}
      className="group/row relative border-b border-border"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          setFocused(false);
      }}
    >
      <button
        type="button"
        data-inbox-row={rowKey(environmentId, notification.id)}
        className="flex w-full min-w-0 gap-2 py-2 pr-3 pl-3 text-left outline-hidden group-hover/row:bg-accent group-focus-within/row:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={open}
      >
        {bar ? (
          <span
            aria-hidden
            className={cn("absolute inset-y-1.5 left-0.5 w-0.5 rounded-full", bar)}
          />
        ) : null}
        <span className="flex h-5 w-1.5 shrink-0 items-center">
          {unread ? <span className="size-1.5 rounded-full bg-primary" /> : null}
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="sr-only">
            {severityLabel[notification.severity]}
            {unread ? ", unread" : ""}:{" "}
          </span>
          <span
            className={cn(
              "line-clamp-2 text-sm wrap-anywhere",
              unread ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {notification.title}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{source}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">
              <RelativeTime timestamp={notification.updatedAt} />
            </span>
            {notification.repeatCount > 0 ? (
              <span className="shrink-0" aria-label={`repeated ${notification.repeatCount} times`}>
                ×{notification.repeatCount + 1}
              </span>
            ) : null}
          </span>
          {environmentLabel || notification.verification ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              <VerificationChip notification={notification} />
              {environmentLabel ? (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {environmentLabel}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
      {/* Mounted on hover or focus only; touch reaches the same actions in the detail. The
          fade lets the title run under the toolbar instead of being cut. */}
      {hovered || focused || menuOpen ? (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded-md bg-accent before:pointer-events-none before:absolute before:inset-y-0 before:-left-6 before:w-6 before:bg-linear-to-r before:from-transparent before:to-accent pointer-coarse:hidden">
          <IconAction
            label={unread ? "Mark read" : "Mark unread"}
            disabled={!actions.permitted}
            onClick={() => actions.run(notification, { type: unread ? "read" : "unread" })}
          >
            {unread ? <MailOpenIcon /> : <MailIcon />}
          </IconAction>
          {tab === "snoozed" ? (
            <IconAction
              label="Unsnooze"
              disabled={!actions.permitted}
              onClick={() => leave({ type: "unsnooze" })}
            >
              <AlarmClockOffIcon />
            </IconAction>
          ) : tab === "inbox" ? (
            <SnoozeMenu
              compact
              disabled={!actions.permitted}
              onOpenChange={setMenuOpen}
              onSnooze={(until) => leave({ type: "snooze", until })}
            />
          ) : null}
          <IconAction
            label={tab === "dismissed" ? "Restore" : "Dismiss"}
            disabled={!actions.permitted}
            onClick={() => leave({ type: tab === "dismissed" ? "restore" : "dismiss" })}
          >
            {tab === "dismissed" ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          </IconAction>
        </div>
      ) : null}
    </li>
  );
});

function BackHeader({
  label,
  onBack,
  backRef,
}: {
  label: string;
  onBack: () => void;
  backRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border px-1.5 py-1.5">
      <Button
        ref={backRef}
        variant="ghost"
        size="icon-sm"
        aria-label="Back to inbox"
        // Opening a detail unmounts the row that had focus.
        autoFocus
        onClick={onBack}
      >
        <ChevronLeftIcon />
      </Button>
      <h3 className="min-w-0 truncate text-sm font-medium">{label}</h3>
    </div>
  );
}

function InboxDetail({ item, now, onBack }: { item: InboxItem; now: number; onBack: () => void }) {
  const { notification, environmentId } = item;
  const navigate = useNavigate();
  const actions = useNotificationActions(environmentId);
  const source = useSourceLabel(environmentId, notification);
  const backRef = useRef<HTMLButtonElement>(null);
  const tab = notificationTab(notification, now);
  const unread = notification.readAt === null;
  const { verification } = notification;
  // Snooze and Unsnooze swap each other out, so focus waits on Back.
  const swap = (action: NotificationAction) => {
    backRef.current?.focus();
    actions.run(notification, action);
    return backRef.current;
  };
  return (
    <>
      <BackHeader label="Inbox" onBack={onBack} backRef={backRef} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
        <div className="space-y-1.5">
          <h4 className="font-medium wrap-anywhere">{notification.title}</h4>
          <div className="flex flex-wrap items-center gap-1">
            <Badge
              size="sm"
              variant={
                notification.severity === "critical"
                  ? "error"
                  : notification.severity === "warning"
                    ? "warning"
                    : "secondary"
              }
            >
              {severityLabel[notification.severity]}
            </Badge>
            <VerificationChip notification={notification} />
            {tab === "snoozed" && notification.snoozedUntil ? (
              <Badge size="sm" variant="outline">
                Snoozed until {new Date(notification.snoozedUntil).toLocaleString()}
              </Badge>
            ) : null}
            {tab === "dismissed" ? (
              <Badge size="sm" variant="outline">
                Dismissed
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground wrap-anywhere">
            {source} · <RelativeTime timestamp={notification.updatedAt} />
            {notification.repeatCount > 0 ? ` · raised ${notification.repeatCount + 1} times` : ""}
            {item.environmentLabel ? ` · ${item.environmentLabel}` : ""}
          </p>
        </div>
        {notification.body ? (
          <ChatMarkdown text={notification.body} cwd={undefined} environmentId={environmentId} />
        ) : null}
        {verification?.note ? (
          <figure className="space-y-1 border-l-2 border-border pl-3">
            <figcaption className="text-xs text-muted-foreground">
              Verifier{verification.model ? ` · ${verification.model.model}` : ""}
            </figcaption>
            <p className="whitespace-pre-wrap wrap-anywhere">{verification.note}</p>
          </figure>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-border p-3">
        {notification.threadId ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: notification.threadId! },
              })
            }
          >
            <MessageSquareIcon />
            Open thread
          </Button>
        ) : null}
        {tab === "snoozed" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!actions.permitted}
            onClick={() => swap({ type: "unsnooze" })}
          >
            <AlarmClockOffIcon />
            Unsnooze
          </Button>
        ) : tab === "inbox" ? (
          <SnoozeMenu
            disabled={!actions.permitted}
            onSnooze={(until) => swap({ type: "snooze", until })}
          />
        ) : null}
        {tab === "dismissed" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!actions.permitted}
            onClick={() => actions.run(notification, { type: "restore" })}
          >
            <ArchiveRestoreIcon />
            Restore
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!actions.permitted}
            onClick={() => actions.run(notification, { type: "dismiss" })}
          >
            <ArchiveIcon />
            Dismiss
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!actions.permitted}
          onClick={() => actions.run(notification, { type: unread ? "read" : "unread" })}
        >
          {unread ? <MailOpenIcon /> : <MailIcon />}
          {unread ? "Mark read" : "Mark unread"}
        </Button>
      </div>
    </>
  );
}

function StatusRow({ onOpen }: { onOpen: () => void }) {
  const { state, groups } = useStatusSignal();
  if (groups.length === 0) return null;
  const sources = groups.flatMap((group) => group.sources ?? []);
  const failing = sources.filter((source) => source.latest.state === "fail").length;
  const warning = sources.filter((source) => source.latest.state === "warn").length;
  const summary = failing
    ? `${failing} failing`
    : warning
      ? `${warning} warning${warning === 1 ? "" : "s"}`
      : "";
  return (
    <button
      type="button"
      data-inbox-row="status"
      className="flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-left text-sm outline-hidden hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onOpen}
    >
      <span className="shrink-0 font-medium">Status</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        {state && state !== "ok" ? <StatusSourceDot state={state} /> : null}
        <span className="truncate">{summary}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Status sources and the notification settings. */
function StatusPanel() {
  const navigate = useNavigate();
  const { groups } = useStatusSignal();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <StatusSourcesList
        groups={groups}
        onConfigureSources={(machine) =>
          void navigate({ to: "/settings/status-sources", search: { machine } })
        }
      />
      <div className="border-t border-border p-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void navigate({ to: "/settings/general", hash: "notifications" })}
        >
          <Settings2Icon />
          Notification settings
        </Button>
      </div>
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p role="status" className="px-3 py-3 text-sm text-muted-foreground">
    {children}
  </p>
);

/** The inbox strip view: tabs, notification rows and detail, and the status panel. */
export function InboxView({ actions }: { actions: HTMLDivElement | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tab = useThreadContextSidebarStore((state) => state.inboxTab);
  const selection = useThreadContextSidebarStore((state) => state.inboxSelection);
  const groups = useInboxEnvironments();
  const markAllRead = useAtomCommand(serverEnvironment.markAllNotificationsRead);
  // A snooze-wake upsert re-renders before the minute ticks; its arrival time ends the snooze.
  const now = Math.max(
    Date.parse(`${useNowMinute()}Z`),
    ...groups.map((group) => group.inbox?.receivedAt ?? 0),
  );
  const multiple = groups.length > 1;
  const all: InboxItem[] = groups
    .flatMap(({ environment, inbox }) =>
      (inbox?.items ?? []).map((notification) => ({
        environmentId: environment.environmentId,
        environmentLabel: multiple ? environment.label : null,
        notification,
      })),
    )
    .sort((a, b) => b.notification.updatedAt.localeCompare(a.notification.updatedAt));
  let snoozedCount = 0;
  const shown: InboxItem[] = [];
  for (const item of all) {
    const itemTab = notificationTab(item.notification, now);
    if (itemTab === "snoozed") snoozedCount += 1;
    if (itemTab === tab) shown.push(item);
  }
  const unread = groups.reduce((total, group) => total + (group.inbox?.unreadCount ?? 0), 0);
  const loading = groups.some((group) => group.inbox === null && !group.failed);
  const failed = groups.some((group) => group.failed);
  const store = useThreadContextSidebarStore.getState;

  const back = () => {
    if (!selection) return;
    const key =
      selection.kind === "notification"
        ? rowKey(selection.environmentId, selection.id)
        : selection.kind;
    flushSync(() => store().selectInbox(null));
    rootRef.current?.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(key)}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Menus portal out of this subtree, so their own Escape never lands here.
    if (
      event.key !== "Escape" ||
      !selection ||
      !(event.target instanceof Node) ||
      !rootRef.current?.contains(event.target)
    )
      return;
    event.preventDefault();
    back();
  };
  const selected =
    selection?.kind === "notification"
      ? all.find(
          (entry) =>
            entry.environmentId === selection.environmentId &&
            entry.notification.id === selection.id,
        )
      : undefined;

  return (
    <div
      ref={rootRef}
      data-inbox-root
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
    >
      {actions
        ? createPortal(
            <ToolHeaderButton
              label="Mark all read"
              disabled={unread === 0}
              onClick={() => {
                for (const group of groups)
                  if (group.inbox?.unreadCount)
                    void markAllRead({ environmentId: group.environment.environmentId, input: {} });
              }}
            >
              <CheckCheckIcon />
            </ToolHeaderButton>,
            actions,
          )
        : null}
      {selection?.kind === "status" ? (
        <>
          <BackHeader label="Status" onBack={back} />
          <StatusPanel />
        </>
      ) : selection?.kind === "notification" ? (
        selected ? (
          <InboxDetail
            key={rowKey(selected.environmentId, selected.notification.id)}
            item={selected}
            now={now}
            onBack={back}
          />
        ) : (
          <>
            <BackHeader label="Inbox" onBack={back} />
            <Note>
              {loading ? "Loading notifications…" : "This notification is no longer available."}
            </Note>
          </>
        )
      ) : (
        <>
          <div className="shrink-0 border-b border-border px-2 py-2">
            <ToggleGroup
              aria-label="Inbox filter"
              size="segmented-compact"
              className="w-full *:flex-1"
              value={[tab]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "inbox" || value === "snoozed" || value === "dismissed")
                  store().setInboxTab(value);
              }}
            >
              {TABS.map((entry) => (
                <Tooltip key={entry.id}>
                  <TooltipTrigger render={<Toggle value={entry.id} aria-label={entry.label} />}>
                    {entry.icon}
                    {entry.id === "snoozed" && snoozedCount > 0 ? (
                      <span className="text-muted-foreground tabular-nums">{snoozedCount}</span>
                    ) : null}
                  </TooltipTrigger>
                  <TooltipPopup>{entry.label}</TooltipPopup>
                </Tooltip>
              ))}
            </ToggleGroup>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "inbox" ? (
              <StatusRow onOpen={() => store().selectInbox({ kind: "status" })} />
            ) : null}
            {failed ? <Note>Could not load notifications.</Note> : null}
            {shown.length > 0 ? (
              <ul aria-label={`${TABS.find((entry) => entry.id === tab)!.label} notifications`}>
                {shown.map((item) => (
                  <InboxRow
                    key={rowKey(item.environmentId, item.notification.id)}
                    notification={item.notification}
                    environmentId={item.environmentId}
                    environmentLabel={item.environmentLabel}
                    tab={tab}
                  />
                ))}
              </ul>
            ) : loading ? (
              <Note>Loading notifications…</Note>
            ) : failed ? null : (
              <Empty size="compact">
                <EmptyMedia variant="icon">
                  {TABS.find((entry) => entry.id === tab)!.icon}
                </EmptyMedia>
                <EmptyTitle>No notifications</EmptyTitle>
                <EmptyDescription>
                  {groups.length > 0
                    ? "Automations and agents post here when something needs you."
                    : "Connect to a server that supports notifications."}
                </EmptyDescription>
              </Empty>
            )}
          </div>
        </>
      )}
    </div>
  );
}
