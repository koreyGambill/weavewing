import type { EnvironmentId, ScheduledTask, ScheduledTaskRunId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SectionHeading } from "../ThreadToolViews";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AutomationRunList } from "./AutomationRunList";

const EMPTY_TASKS: ReadonlyArray<ScheduledTask> = [];

export function EnvironmentAutomationHistory({
  environmentId,
  grouped,
}: {
  environmentId: EnvironmentId;
  grouped: boolean;
}) {
  const environment = useEnvironment(environmentId);
  const history = useRef<HTMLElement>(null);
  const inventory = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const [selection, setSelection] = useState<string | null>(null);
  const tasks = inventory.data?.tasks ?? EMPTY_TASKS;
  const taskId = tasks.find((task) => task.id === selection)?.id;
  const items = [
    { value: "", label: "All automations" },
    ...tasks
      .map((task) => ({ value: task.id, label: task.title }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  const [cursors, setCursors] = useState<ScheduledTaskRunId[]>([]);
  const before = cursors.at(-1);
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTaskRuns({
      environmentId,
      input: { ...(taskId === undefined ? {} : { id: taskId }), ...(before ? { before } : {}) },
    }),
  );
  const previousTasks = useRef(tasks);
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Live task updates invalidate the newest history page.
  useEffect(() => {
    if (previousTasks.current === tasks) return;
    previousTasks.current = tasks;
    if (before === undefined) refresh();
  }, [tasks, before, refresh]);

  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const runs = query.data?.runs ?? [];
  const oldest = runs.at(-1)?.id;
  return (
    <section
      ref={history}
      className="space-y-2"
      aria-label={grouped ? environment?.label : undefined}
    >
      <div className="sticky top-0 z-10 space-y-2 bg-sidebar pb-1">
        {grouped ? <SectionHeading>{environment?.label ?? "Environment"}</SectionHeading> : null}
        {inventory.error !== null ? (
          <p className="text-destructive">Could not load automation names: {inventory.error}</p>
        ) : null}
        <Select
          items={items}
          value={taskId ?? ""}
          onValueChange={(value) => {
            setSelection(value);
            setCursors([]);
            history.current?.scrollIntoView({ block: "start" });
          }}
        >
          <SelectTrigger size="compact" aria-label="Filter runs by automation">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        {before !== undefined || query.data?.hasMore ? (
          <div className="flex items-center justify-between gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={before === undefined}
              onClick={() => {
                setCursors((pages) => pages.slice(0, -1));
                history.current?.scrollIntoView({ block: "start" });
              }}
            >
              Newer
            </Button>
            <span className="text-muted-foreground">Page {cursors.length + 1}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={!query.data?.hasMore || oldest === undefined}
              onClick={() => {
                if (oldest === undefined) return;
                setCursors((pages) => [...pages, oldest]);
                history.current?.scrollIntoView({ block: "start" });
              }}
            >
              Older
            </Button>
          </div>
        ) : null}
      </div>
      {query.error !== null ? (
        <p className="text-destructive">Could not load run history: {query.error}</p>
      ) : query.data === null ? (
        <p className="text-muted-foreground">Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className="text-muted-foreground">No runs to show.</p>
      ) : (
        <AutomationRunList
          environmentId={environmentId}
          runs={runs}
          {...(taskId === undefined ? { taskTitles: titles } : {})}
        />
      )}
    </section>
  );
}
