import { runOutcomeLabel } from "@t3tools/client-runtime/automations";
import type { EnvironmentId, ScheduledTask, ScheduledTaskRun, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { FitSheet } from "../../../components/ui/FitSheet";
import { Sheet } from "../../../components/ui/Sheet";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { createInboxDismissal } from "../../inbox/inboxDismissal";

export function ScheduledTaskHistorySheet({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Pick<ScheduledTask, "id" | "title" | "lastRunAt" | "lastRunEndedAt">;
  readonly onClose: (threadId: ThreadId | null) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTaskRuns({ environmentId, input: { id: task.id } }),
  );
  const { refresh } = query;
  const refreshKey = `${task.lastRunAt ?? ""}|${task.lastRunEndedAt ?? ""}`;
  const seenKey = useRef(refreshKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A run starting or ending changes the live task and invalidates the history query.
  useEffect(() => {
    if (seenKey.current === refreshKey) return;
    seenKey.current = refreshKey;
    refresh();
  }, [refreshKey, refresh]);

  const [leavingTo, setLeavingTo] = useState<ThreadId | null>(null);
  const [dismissal] = useState(createInboxDismissal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Clears the dismissal fallback timer when the sheet unmounts.
  useEffect(() => dismissal.dispose, [dismissal]);
  const openThread = (threadId: ThreadId) => {
    setLeavingTo(threadId);
    dismissal.arm(() => onClose(threadId));
  };

  return (
    <Sheet
      title="Run history"
      open={leavingTo === null}
      onClose={() => dismissal.complete(() => onClose(leavingTo))}
    >
      <FitSheet header={null} contentContainerClassName="gap-3 px-5 pt-4">
        <Text className="font-t3-medium text-base">{task.title}</Text>
        {query.error ? (
          <View className="items-start gap-3">
            <Text className="text-sm text-danger-foreground">
              Could not load runs: {query.error}
            </Text>
            <Button label="Try again" onPress={refresh} />
          </View>
        ) : query.data === null ? (
          <Text className="text-sm text-foreground-muted">Loading runs…</Text>
        ) : query.data.runs.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No runs yet.</Text>
        ) : (
          <>
            {query.data.runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                disabled={leavingTo !== null}
                onOpenThread={openThread}
              />
            ))}
            {query.data.hasMore ? (
              <Text className="text-sm text-foreground-muted">
                Showing the newest {query.data.runs.length} runs.
              </Text>
            ) : null}
          </>
        )}
      </FitSheet>
    </Sheet>
  );
}

const runTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function RunRow({
  run,
  disabled,
  onOpenThread,
}: {
  readonly run: ScheduledTaskRun;
  readonly disabled: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const outcome = runOutcomeLabel(run);
  const time = runTime.format(new Date(run.startedAt));
  const detail = run.error ?? run.trigger.summary;
  const content = (
    <View className="min-w-0 flex-1 gap-1">
      <Text className="font-t3-medium text-sm">{outcome}</Text>
      <Text className="text-sm text-foreground-secondary">{time}</Text>
      {detail ? <Text className="text-sm text-foreground-secondary">{detail}</Text> : null}
    </View>
  );
  const threadId = run.threadId;
  return threadId === null ? (
    <View className="py-2">{content}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${outcome}, ${time}. Open thread`}
      accessibilityHint={detail || undefined}
      disabled={disabled}
      onPress={() => onOpenThread(threadId)}
      className="min-h-11 flex-row items-center gap-2 py-2 active:opacity-60"
    >
      {content}
      <SymbolView
        name="chevron.right"
        size={14}
        type="monochrome"
        tintColorClassName="accent-icon-muted"
      />
    </Pressable>
  );
}
