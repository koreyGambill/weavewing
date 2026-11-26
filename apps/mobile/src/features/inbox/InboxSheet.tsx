import { RegistryContext } from "@effect/atom-react";
import type { NotificationTab } from "@t3tools/client-runtime/state/notifications";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useContext, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Sheet } from "../../components/ui/Sheet";
import { useNowMinuteMs } from "../../lib/clock";
import { serverEnvironment } from "../../state/server";
import {
  INBOX_TABS,
  inboxEmptyCopy,
  inboxFailureMessage,
  inboxItemKey,
  inboxNow,
  inboxSignal,
  inboxTabLabel,
  inboxView,
  markAllReadEnvironmentIds,
  type InboxEnvironment,
  type InboxThreadTarget,
} from "./inbox.logic";
import { createInboxDismissal } from "./inboxDismissal";
import { InboxItemRow } from "./InboxItemRow";

/**
 * The notifications inbox: every connected environment's items, newest first, in web's Inbox,
 * Snoozed and Dismissed views. Mounted only while open.
 */
export function InboxSheet(props: {
  readonly environments: ReadonlyArray<InboxEnvironment>;
  /** Runs once the sheet is gone, with the thread to open when an item asked for one. */
  readonly onClose: (thread: InboxThreadTarget | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const registry = useContext(RegistryContext);
  const [tab, setTab] = useState<NotificationTab>("inbox");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  // Navigation waits for the dismissal, so the thread never opens under a closing sheet.
  const [leavingTo, setLeavingTo] = useState<InboxThreadTarget | null>(null);
  // The native dismissal and its fallback share one completion, so navigation and the header's
  // closed state happen once, whichever comes first.
  const [dismissal] = useState(createInboxDismissal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the dismissal fallback timer when the sheet unmounts
  useEffect(() => dismissal.dispose, [dismissal]);
  const leave = (thread: InboxThreadTarget) => {
    setLeavingTo(thread);
    dismissal.arm(() => props.onClose(thread));
  };
  const nowMs = inboxNow(props.environments, useNowMinuteMs());
  const view = inboxView(props.environments, tab, nowMs);
  const signal = inboxSignal(props.environments);
  const empty = inboxEmptyCopy(tab, props.environments.length);
  const markAllTargets = markAllReadEnvironmentIds(props.environments);

  const markAllRead = async () => {
    setMarkingAll(true);
    setMarkAllError(null);
    // Each environment counts its own unread, so each one marks its own.
    const failures = (
      await Promise.all(
        markAllTargets.map(async (environmentId) => ({
          environmentId,
          result: await runAtomCommand(
            registry,
            serverEnvironment.markAllNotificationsRead,
            { environmentId, input: {} },
            { reportFailure: false },
          ),
        })),
      )
    ).filter(({ result }) => result._tag === "Failure" && !isAtomCommandInterrupted(result));
    setMarkingAll(false);
    if (failures.length === 0) return;
    const labelled = props.environments.length > 1;
    setMarkAllError(
      failures
        .map(({ environmentId, result }) => {
          const label = props.environments.find(
            (environment) => environment.environmentId === environmentId,
          )?.label;
          const message =
            result._tag === "Failure" ? inboxFailureMessage(squashAtomCommandFailure(result)) : "";
          return `Could not mark all read${labelled && label ? ` on ${label}` : ""}: ${message}`;
        })
        .join("\n"),
    );
  };

  return (
    <Sheet
      title="Inbox"
      open={leavingTo === null}
      onClose={() => dismissal.complete(() => props.onClose(leavingTo))}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        <SegmentedControl
          role="tab"
          selected={tab}
          onSelect={(next) => {
            setTab(next);
            setExpanded(null);
          }}
          options={INBOX_TABS.map((entry) => ({
            value: entry.value,
            ...inboxTabLabel(entry.value, {
              unread: signal.unread,
              snoozed: view.snoozedCount,
            }),
          }))}
        />
        <View className="min-h-11 flex-row items-center justify-end px-1">
          <Button
            label="Mark all read"
            icon="checkmark"
            tone="text"
            disabled={markAllTargets.length === 0}
            loading={markingAll}
            onPress={() => void markAllRead()}
          />
        </View>
        {markAllError === null ? null : (
          <Text selectable className="px-1 font-sans text-sm text-danger-foreground">
            {markAllError}
          </Text>
        )}
        {signal.failed ? (
          <Text accessibilityRole="alert" className="px-1 font-sans text-sm text-danger-foreground">
            Could not load notifications.
          </Text>
        ) : null}
        {view.shown.length > 0 ? (
          <View className="gap-1">
            {view.shown.map((item) => {
              const key = inboxItemKey(item);
              return (
                <InboxItemRow
                  key={key}
                  item={item}
                  tab={tab}
                  nowMs={nowMs}
                  expanded={expanded === key}
                  onToggle={() => setExpanded(expanded === key ? null : key)}
                  onOpenThread={leave}
                />
              );
            })}
          </View>
        ) : signal.loading ? (
          <Text className="px-1 font-sans text-sm text-foreground-secondary">
            Loading notifications…
          </Text>
        ) : signal.failed ? null : (
          <EmptyState variant="plain" title={empty.title} detail={empty.detail} />
        )}
      </ScrollView>
    </Sheet>
  );
}
