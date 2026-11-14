import { Link, useNavigate } from "@tanstack/react-router";
import {
  AuthOrchestrationReadScope,
  ThreadId,
  type ScopedThreadRef,
  type ThreadTimeline,
  type ThreadTimelineRelation,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { ChartGanttIcon, ZoomInIcon } from "lucide-react";
import { useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useNowMinute } from "../hooks/useNowMinute";
import { useClientSettings } from "../hooks/useSettings";
import { tickTextContent } from "../lib/tickTextContent";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { threadTimelineGet } from "../state/threadInsights";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatDayAwareTimestamp } from "../timestampFormat";
import {
  availableZooms,
  layoutTimeline,
  runEnd,
  summarizeTimeline,
  type TimelineBar,
  type TimelineLaneLayout,
} from "./threadTimeline.logic";
import { CheckedLabel } from "./ToolFilterMenuTrigger";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyMedia } from "./ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const RELATIONS: ReadonlyArray<{ relation: ThreadTimelineRelation; label: string; fill: string }> =
  [
    { relation: "self", label: "This thread", fill: "bg-primary" },
    { relation: "delegate", label: "Delegate", fill: "bg-emerald-500" },
    { relation: "subagent", label: "Subagent", fill: "bg-fuchsia-500" },
    { relation: "side-chat", label: "Side chat", fill: "bg-amber-500" },
  ];
const fillOf = (relation: ThreadTimelineRelation) =>
  RELATIONS.find((entry) => entry.relation === relation)?.fill ?? "bg-primary";

function barClass(bar: TimelineBar, relation: ThreadTimelineRelation) {
  switch (bar.status) {
    case "failed":
      return "bg-destructive";
    case "interrupted":
      return cn(fillOf(relation), "opacity-40");
    case "cancelled":
    case "rolled_back":
      return "bg-muted-foreground/40";
    default:
      return fillOf(relation);
  }
}

const STATUS_LABEL: Partial<Record<string, string>> = {
  completed: "Completed",
  running: "Running",
  waiting: "Waiting",
  starting: "Starting",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
};

type Hover =
  | { readonly kind: "run"; readonly run: number; readonly element: HTMLElement }
  | { readonly kind: "lane"; readonly lane: TimelineLaneLayout; readonly element: HTMLElement };

export function ThreadTimelineView({
  threadRef,
  actions,
}: {
  threadRef: ScopedThreadRef;
  actions: HTMLDivElement | null;
}) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    canRead
      ? threadTimelineGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const timeline = query.data;
  if (!canRead)
    return <p className="text-xs text-muted-foreground">This connection cannot read runs.</p>;
  if (query.error && !timeline)
    return <p className="text-xs text-muted-foreground">{query.error}</p>;
  if (!timeline) return null;
  if (!timeline.runs.length)
    return (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <ChartGanttIcon />
        </EmptyMedia>
        <EmptyDescription>Runs of this thread and its delegates appear here.</EmptyDescription>
      </Empty>
    );
  return (
    <TimelineChart
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      timeline={timeline}
      answeredAt={query.dataUpdatedAt}
      actions={actions}
    />
  );
}

function TimelineChart({
  threadRef,
  timeline,
  answeredAt,
  actions,
}: {
  threadRef: ScopedThreadRef;
  timeline: ThreadTimeline;
  /** When this answer arrived; it can be later than the minute tick, which a just-started run is. */
  answeredAt: number;
  actions: HTMLDivElement | null;
}) {
  const now = Math.max(Date.parse(`${useNowMinute()}Z`), answeredAt);
  const [zoom, onZoom] = useState<number | null>(null);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const navigate = useNavigate();
  const [hover, setHover] = useState<Hover | null>(null);
  const whole = layoutTimeline(timeline, { now, windowMs: null });
  const zooms = availableZooms(whole.spanMs);
  const windowMs = zooms.some((option) => option.ms === zoom) ? zoom : null;
  const layout = windowMs === null ? whole : layoutTimeline(timeline, { now, windowMs });
  const live = timeline.runs.some((run) => run.durationMs === null);
  const time = (ms: number) =>
    formatDayAwareTimestamp(new Date(ms).toISOString(), timestampFormat, now);
  const threadOf = (lane: number) =>
    scopeThreadRef(
      threadRef.environmentId,
      ThreadId.make(timeline.lanes[lane]?.threadId ?? threadRef.threadId),
    );
  const runAt = (target: EventTarget) => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-run]") : null;
    const run = Number(element?.dataset.run);
    return element && Number.isInteger(run) ? { element, run } : null;
  };
  const onPointerOver = (event: PointerEvent) => {
    const found = runAt(event.target);
    if (!found) return setHover((current) => (current?.kind === "run" ? null : current));
    if (hover?.kind !== "run" || hover.run !== found.run)
      setHover({ kind: "run", run: found.run, element: found.element });
  };
  return (
    <div className="space-y-3 text-xs">
      {actions && zooms.length
        ? createPortal(
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <Button
                          variant={windowMs === null ? "ghost" : "secondary"}
                          size="icon-sm"
                          aria-label="Time window"
                        />
                      }
                    />
                  }
                >
                  <ZoomInIcon />
                </TooltipTrigger>
                <TooltipPopup>Time window</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Time window</MenuGroupLabel>
                  <MenuRadioGroup
                    value={String(windowMs ?? "all")}
                    onValueChange={(next) => onZoom(next === "all" ? null : Number(next))}
                  >
                    <MenuRadioItem value="all">
                      <CheckedLabel>Whole thread</CheckedLabel>
                    </MenuRadioItem>
                    {zooms.map((option) => (
                      <MenuRadioItem key={option.ms} value={String(option.ms)}>
                        <CheckedLabel>{option.label}</CheckedLabel>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuPopup>
            </Menu>,
            actions,
          )
        : null}
      <dl className="grid grid-cols-3 gap-2">
        {(
          [
            ["Wall", (ms: number) => formatSpan(summarizeTimeline(timeline, ms).wallMs)],
            ["Agent", (ms: number) => formatSpan(summarizeTimeline(timeline, ms).agentMs)],
            ["Runs", () => String(timeline.totals.runs)],
          ] as const
        ).map(([label, format]) => (
          <div key={label} className="min-w-0">
            <dt className="text-3xs text-muted-foreground">{label}</dt>
            <dd ref={tickTextContent(format, live)} className="truncate font-medium tabular-nums" />
          </div>
        ))}
      </dl>
      <p
        ref={tickTextContent((ms) => modelLine(summarizeTimeline(timeline, ms).models), live)}
        className="text-3xs text-muted-foreground empty:hidden"
      />
      <div>
        <div className="flex justify-between gap-2 text-3xs text-muted-foreground tabular-nums">
          <span className="truncate">{time(layout.start)}</span>
          <span className="shrink-0">
            {time(layout.end) === time(layout.start)
              ? `+${formatDuration(layout.spanMs)}`
              : time(layout.end)}
          </span>
        </div>
        <div
          className="mt-1 space-y-1.5"
          onPointerOver={onPointerOver}
          onPointerLeave={() => setHover(null)}
          onClick={(event) => {
            const found = runAt(event.target);
            const run = found ? timeline.runs[found.run] : undefined;
            if (run)
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(threadOf(run.lane)),
              });
          }}
        >
          {layout.lanes.map((lane) => (
            <div key={lane.lane} style={{ paddingLeft: `${Math.min(lane.depth, 6) * 8}px` }}>
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(threadOf(lane.lane))}
                className="block truncate text-3xs leading-4 text-foreground/80 hover:underline focus-visible:underline"
                onFocus={(event) => setHover({ kind: "lane", lane, element: event.currentTarget })}
                onBlur={() => setHover(null)}
              >
                {lane.title || "Untitled thread"}
              </Link>
              <div className="relative h-2 overflow-hidden rounded-sm bg-muted/50">
                {lane.bars.map((bar) => (
                  <BarMark key={bar.run} bar={bar} relation={lane.relation} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {layout.hiddenLanes > 0 || layout.omittedRuns > 0 ? (
        <p className="text-3xs text-muted-foreground">
          {[
            layout.hiddenLanes > 0 ? `${layout.hiddenLanes} quieter threads not shown` : null,
            layout.omittedRuns > 0 ? `${layout.omittedRuns} older runs not drawn` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
        {[
          ...RELATIONS.map(({ label, fill }) => [label, fill] as const),
          ["Failed", "bg-destructive"] as const,
          ["Stopped", "bg-muted-foreground/40"] as const,
        ].map(([label, fill]) => (
          <li key={label} className="flex items-center gap-1">
            <span className={cn("size-2 rounded-xs", fill)} />
            {label}
          </li>
        ))}
      </ul>
      <Tooltip open={hover !== null} onOpenChange={(open) => (open ? undefined : setHover(null))}>
        {hover ? (
          <TooltipPopup anchor={hover.element} side="bottom">
            {hover.kind === "run" ? (
              <RunDetails timeline={timeline} run={hover.run} time={time} />
            ) : (
              <LaneDetails timeline={timeline} lane={hover.lane} now={now} />
            )}
          </TooltipPopup>
        ) : null}
      </Tooltip>
    </div>
  );
}

function BarMark({ bar, relation }: { bar: TimelineBar; relation: ThreadTimelineRelation }) {
  return (
    <>
      {bar.queueWidth > 0 ? (
        <span
          className="absolute top-1/2 h-px bg-muted-foreground/50"
          style={{ left: `${bar.queueLeft}%`, width: `${bar.queueWidth}%` }}
        />
      ) : null}
      <span
        data-run={bar.run}
        className={cn(
          "absolute inset-y-0 min-w-0.5 cursor-pointer rounded-xs",
          barClass(bar, relation),
          bar.open && "rounded-r-none border-r-2 border-foreground",
        )}
        style={{ left: `min(${bar.left}%, 100% - 2px)`, width: `${bar.width}%` }}
      />
    </>
  );
}

function RunDetails({
  timeline,
  run: index,
  time,
}: {
  timeline: ThreadTimeline;
  run: number;
  time: (ms: number) => string;
}) {
  const run = timeline.runs[index];
  if (!run) return null;
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{timeline.lanes[run.lane]?.title || "Untitled thread"}</p>
      <p className="text-muted-foreground">
        Run {run.ordinal} · {timeline.models[run.model] || "Unknown model"}
      </p>
      <p
        ref={tickTextContent(
          (ms) =>
            `${STATUS_LABEL[run.status] ?? run.status} · ${formatDuration(runEnd(run, ms) - run.startedAt)}${run.durationMs === null ? " so far" : ""}`,
          run.durationMs === null,
        )}
      />
      <p className="text-muted-foreground">
        Started {time(run.startedAt)}
        {run.queuedMs >= 1000 ? ` after ${formatDuration(run.queuedMs)} queued` : ""}
      </p>
    </div>
  );
}

function LaneDetails({
  timeline,
  lane,
  now,
}: {
  timeline: ThreadTimeline;
  lane: TimelineLaneLayout;
  now: number;
}) {
  const agentMs = lane.bars.reduce((sum, bar) => {
    const run = timeline.runs[bar.run];
    return run ? sum + runEnd(run, now) - run.startedAt : sum;
  }, 0);
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{lane.title || "Untitled thread"}</p>
      <p className="text-muted-foreground">
        {RELATIONS.find((entry) => entry.relation === lane.relation)?.label} · {lane.bars.length}{" "}
        {lane.bars.length === 1 ? "run" : "runs"} · {formatSpan(agentMs)}
      </p>
    </div>
  );
}

function modelLine(models: ReadonlyArray<{ readonly model: string; readonly ms: number }>) {
  const shown = models
    .slice(0, 3)
    .map((entry) => `${entry.model || "Unknown"} ${formatSpan(entry.ms)}`);
  if (models.length > shown.length) shown.push(`${models.length - shown.length} more`);
  return shown.join(" · ");
}

function formatSpan(ms: number) {
  if (ms < 60_000) return formatDuration(ms);
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  if (hours >= 48)
    return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours / 24}d`;
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
