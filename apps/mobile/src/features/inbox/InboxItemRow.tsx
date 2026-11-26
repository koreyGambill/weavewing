import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { NotificationTab } from "@t3tools/client-runtime/state/notifications";
import {
  pickSnoozePreset,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import type { NotificationAction } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  INBOX_SEVERITY_LABEL,
  INBOX_SNOOZE_PRESETS,
  inboxActionLabel,
  inboxActionOutcome,
  inboxItemActions,
  inboxSourceLabel,
  inboxUpdateRequest,
  openInboxThread,
  type InboxItem,
  type InboxThreadTarget,
} from "./inbox.logic";

const ACTION_ICON: Record<NotificationAction["type"], AppSymbolName> = {
  read: "checkmark",
  unread: "envelope.badge",
  snooze: "clock",
  unsnooze: "arrow.uturn.backward",
  dismiss: "archivebox",
  restore: "arrow.uturn.backward",
};

/** What raised the item, named from the thread or automation the environment knows. */
function useSourceLabel(item: InboxItem): string {
  const { source } = item.notification;
  const shell = useThreadShell(
    source.kind === "agent" ? scopeThreadRef(item.environmentId, source.threadId) : null,
  );
  const taskId =
    source.kind === "automation" || source.kind === "review" ? source.scheduledTaskId : null;
  const tasks = useEnvironmentQuery(
    taskId === null
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId: item.environmentId, input: {} }),
  );
  return inboxSourceLabel(item.notification, {
    threadTitle: shell?.title ?? null,
    taskTitle: tasks.data?.tasks.find((task) => task.id === taskId)?.title ?? null,
  });
}

/**
 * One inbox item. Tapping one that points to a thread opens it and marks it read; any other
 * opens its detail in place. The chevron shows the full text and actions for every item.
 */
export function InboxItemRow(props: {
  readonly item: InboxItem;
  readonly tab: NotificationTab;
  readonly nowMs: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (thread: InboxThreadTarget) => void;
}) {
  const { item, tab } = props;
  const { notification } = item;
  const permitted = useAtomValue(
    serverEnvironment.updateNotifications.permissionAtom(item.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateNotifications, { reportFailure: false });
  const source = useSourceLabel(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unread = notification.readAt === null;
  const usable = permitted && !busy;

  const run = async (action: NotificationAction) => {
    setBusy(true);
    setError(null);
    const outcome = inboxActionOutcome(action.type, await update(inboxUpdateRequest(item, action)));
    setBusy(false);
    if (!outcome.ok) setError(outcome.error);
    return outcome;
  };
  // The sheet closes only once the read is saved, so a failed one stays visible on the row.
  const openThread = async () => {
    if (busy) return;
    const outcome = await openInboxThread(item, permitted, () => run({ type: "read" }));
    if (outcome._tag === "navigate") props.onOpenThread(outcome.thread);
  };
  const open = () => {
    if (notification.threadId !== null) {
      void openThread();
      return;
    }
    if (!props.expanded) props.onToggle();
    if (unread && permitted) void run({ type: "read" });
  };
  const severity =
    notification.severity === "info" ? null : INBOX_SEVERITY_LABEL[notification.severity];
  const spoken = [
    unread ? "Unread" : null,
    severity,
    notification.title,
    source,
    item.environmentLabel,
  ]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <View className="gap-2">
      <View className="flex-row items-start">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={spoken}
          accessibilityHint={
            notification.threadId === null ? "Shows the full notification" : "Opens its thread"
          }
          onPress={open}
          className="min-h-11 min-w-0 flex-1 flex-row items-start gap-2 rounded-xl py-2.5 pr-1 pl-2 active:bg-subtle"
        >
          <View className="h-5 w-2 items-center justify-center">
            {unread ? <View className="size-2 rounded-full bg-primary" /> : null}
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text
              className={cn(
                "text-sm",
                unread ? "font-t3-bold text-foreground" : "font-sans text-foreground-secondary",
              )}
              numberOfLines={2}
            >
              {notification.title}
            </Text>
            {notification.body !== undefined && !props.expanded ? (
              <Text className="font-sans text-xs text-foreground-muted" numberOfLines={2}>
                {notification.body}
              </Text>
            ) : null}
            <View className="flex-row flex-wrap items-center gap-x-1">
              {severity === null ? null : (
                <Text
                  className={cn(
                    "font-t3-medium text-xs",
                    notification.severity === "critical"
                      ? "text-danger-foreground"
                      : "text-warning-foreground",
                  )}
                >
                  {severity} ·
                </Text>
              )}
              <Text className="shrink font-sans text-xs text-foreground-muted" numberOfLines={1}>
                {source}
              </Text>
              <Text className="font-sans text-xs text-foreground-muted">
                · <RelativeTime timestamp={notification.updatedAt} />
                {notification.repeatCount > 0 ? ` · ×${notification.repeatCount + 1}` : ""}
              </Text>
            </View>
            {item.environmentLabel === null ? null : (
              <Text className="font-sans text-xs text-foreground-muted" numberOfLines={1}>
                {item.environmentLabel}
              </Text>
            )}
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.expanded ? "Hide" : "Show"} details: ${notification.title}`}
          accessibilityState={{ expanded: props.expanded }}
          onPress={props.onToggle}
          className="size-11 items-center justify-center rounded-xl active:bg-subtle"
        >
          <SymbolView
            name={props.expanded ? "chevron.up" : "chevron.down"}
            size={12}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
      </View>
      {props.expanded ? (
        <InboxItemDetail
          item={item}
          tab={tab}
          nowMs={props.nowMs}
          source={source}
          usable={usable}
          busy={busy}
          onRun={run}
          onOpenThread={() => void openThread()}
        />
      ) : null}
      {error === null ? null : (
        <Text selectable className="px-2 font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}

function InboxItemDetail(props: {
  readonly item: InboxItem;
  readonly tab: NotificationTab;
  readonly nowMs: number;
  readonly source: string;
  readonly usable: boolean;
  readonly busy: boolean;
  readonly onRun: (action: NotificationAction) => Promise<unknown>;
  readonly onOpenThread: () => void;
}) {
  const { item, tab } = props;
  const { notification } = item;
  const { verification } = notification;
  const facts = [
    INBOX_SEVERITY_LABEL[notification.severity],
    verification?.status === "confirmed"
      ? `Verified${verification.model ? ` · ${verification.model.model}` : ""}`
      : verification?.status === "unverified"
        ? "Unverified"
        : null,
    tab === "snoozed" && notification.snoozedUntil !== null
      ? `Snoozed until ${new Date(notification.snoozedUntil).toLocaleString()}`
      : null,
    tab === "dismissed" ? "Dismissed" : null,
  ].filter((fact) => fact !== null);
  const raised = [
    props.source,
    new Date(notification.updatedAt).toLocaleString(),
    notification.repeatCount > 0 ? `raised ${notification.repeatCount + 1} times` : null,
    item.environmentLabel,
  ].filter((part) => part !== null);
  const threadId = notification.threadId;

  return (
    <View className="ml-4 gap-3 rounded-2xl border border-border-subtle bg-card px-3.5 py-3">
      <View className="gap-1">
        <Text selectable className="font-t3-bold text-sm text-foreground">
          {notification.title}
        </Text>
        <Text className="font-t3-medium text-xs text-foreground-muted">{facts.join(" · ")}</Text>
        <Text selectable className="font-sans text-xs text-foreground-muted">
          {raised.join(" · ")}
        </Text>
      </View>
      {notification.body === undefined ? null : (
        <Text selectable className="font-sans text-sm text-foreground">
          {notification.body}
        </Text>
      )}
      {verification?.note ? (
        <View className="gap-0.5 border-l-2 border-border-subtle pl-3">
          <Text className="font-sans text-xs text-foreground-muted">
            Verifier{verification.model ? ` · ${verification.model.model}` : ""}
          </Text>
          <Text selectable className="font-sans text-sm text-foreground">
            {verification.note}
          </Text>
        </View>
      ) : null}
      {inboxItemActions(notification, tab).includes("snooze") ? (
        <SnoozeChoices
          nowMs={props.nowMs}
          disabled={!props.usable}
          onSnooze={(until) => void props.onRun({ type: "snooze", until })}
        />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {threadId === null ? null : (
          <Button
            label="Open thread"
            icon="bubble.left"
            tone="primary"
            disabled={props.busy}
            onPress={props.onOpenThread}
          />
        )}
        {inboxItemActions(notification, tab).map((action) =>
          action === "snooze" ? null : (
            <Button
              key={action}
              label={inboxActionLabel(action)}
              icon={ACTION_ICON[action]}
              tone="secondary"
              disabled={!props.usable}
              onPress={() => void props.onRun({ type: action })}
            />
          ),
        )}
      </View>
    </View>
  );
}

/**
 * Snooze's chooser, inline in the detail: Android draws menus in the activity's overlay, behind
 * the sheet's own window.
 */
function SnoozeChoices(props: {
  readonly nowMs: number;
  readonly disabled: boolean;
  readonly onSnooze: (until: string) => void;
}) {
  const presets = resolveSnoozePresets(new Date(props.nowMs), { presets: INBOX_SNOOZE_PRESETS });
  return (
    <View className="gap-1.5">
      <Text className="font-sans text-xs text-foreground-muted">{inboxActionLabel("snooze")}</Text>
      <View className="flex-row flex-wrap gap-2">
        {presets.map((preset) => (
          <Button
            key={preset.id}
            label={`${preset.label} · ${preset.whenLabel}`}
            accessibilityLabel={`Snooze: ${preset.label}, ${preset.whenLabel}`}
            icon={ACTION_ICON.snooze}
            tone="secondary"
            disabled={props.disabled}
            onPress={() => {
              // A duration starts at the tap, not at the minute the buttons were drawn.
              const picked = pickSnoozePreset({
                shown: presets,
                id: preset.id,
                now: new Date(),
                presets: INBOX_SNOOZE_PRESETS,
              });
              if (picked) props.onSnooze(picked.snoozedUntil);
            }}
          />
        ))}
      </View>
    </View>
  );
}
