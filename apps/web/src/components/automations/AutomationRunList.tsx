import type { EnvironmentId, ScheduledTaskId, ScheduledTaskRun } from "@t3tools/contracts";
import {
  BanIcon,
  CheckIcon,
  CircleDotIcon,
  SkipForwardIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { runCostLabel, runOutcomeLabel } from "./automationsView.logic";
import { useOpenThread } from "./useAutomations";

const RUN_ICONS: Record<string, { icon: ReactNode; tone: string }> = {
  running: { icon: <CircleDotIcon />, tone: "text-info" },
  quiet: { icon: <CheckIcon />, tone: "text-success" },
  notified: { icon: <TriangleAlertIcon />, tone: "text-warning" },
  suppressed: { icon: <BanIcon />, tone: "text-muted-foreground" },
  skipped: { icon: <SkipForwardIcon />, tone: "text-muted-foreground" },
};
const FAILED_ICON = { icon: <XIcon />, tone: "text-destructive" };

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function runTimeLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - date.getTime()) / 86_400_000) + 1;
  const time = timeFormat.format(date);
  if (date >= today) return `Today ${time}`;
  if (days <= 1) return `Yesterday ${time}`;
  if (days < 7) return `${weekdayFormat.format(date)} ${time}`;
  return `${dateFormat.format(date)} ${time}`;
}

/** A page of runs with links to their threads. */
export function AutomationRunList(props: {
  environmentId: EnvironmentId;
  runs: ReadonlyArray<ScheduledTaskRun>;
  hasMore?: boolean;
  taskTitles?: ReadonlyMap<ScheduledTaskId, string>;
}) {
  const openThread = useOpenThread();
  return (
    <>
      <ul className="m-0 list-none space-y-0.5 p-0">
        {props.runs.map((run) => {
          const { icon, tone } = RUN_ICONS[run.status] ?? FAILED_ICON;
          const title =
            props.taskTitles && (props.taskTitles.get(run.taskId) ?? "Unknown automation");
          const time = runTimeLabel(run.startedAt);
          const detail = [
            runOutcomeLabel(run),
            ...(title ? [time] : []),
            runCostLabel(run),
            run.error ?? run.trigger.summary,
          ]
            .filter(Boolean)
            .join(" · ");
          const content = (
            <>
              <span aria-hidden className={cn("mt-0.5 shrink-0 [&_svg]:size-3.5", tone)}>
                {icon}
              </span>
              <Tooltip>
                <TooltipTrigger render={<span className="min-w-0 flex-1" />}>
                  <span className="block truncate text-foreground">{title ?? time}</span>
                  <span
                    className={cn(
                      "block text-muted-foreground",
                      run.error ? "line-clamp-3 break-words" : "truncate",
                    )}
                  >
                    {detail}
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {title ? <span className="block">{title}</span> : null}
                  <span className="block">{new Date(run.startedAt).toLocaleString()}</span>
                  <span className="block">{detail}</span>
                </TooltipPopup>
              </Tooltip>
            </>
          );
          return (
            <li key={run.id}>
              {run.threadId === null ? (
                <div className="flex min-w-0 items-start gap-2 px-1.5 py-1">{content}</div>
              ) : (
                <button
                  type="button"
                  className="flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left outline-hidden ring-ring hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset"
                  onClick={() => run.threadId && void openThread(props.environmentId, run.threadId)}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {props.hasMore ? (
        <p className="px-1.5 text-muted-foreground">Showing the newest {props.runs.length} runs.</p>
      ) : null}
    </>
  );
}
