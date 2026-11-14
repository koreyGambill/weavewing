import {
  AuthOrchestrationReadScope,
  RunId,
  type ScopedThreadRef,
  type ThreadInsights,
  type ThreadLoadEvent,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { FileTextIcon, BookOpenIcon, CircleHelpIcon } from "lucide-react";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadInsightsGet } from "../../state/threadInsights";
import { SidebarSearchField } from "../sidebar/SidebarSearchField";
import { CheckedLabel, ToolFilterMenuTrigger } from "../ToolFilterMenuTrigger";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { InspectControls, InspectRefreshButton } from "./InspectControls";
import { filterLoadEvents, reportedUsageTotals } from "./insightDisplay";
import { UsageTimeline } from "./UsageTimeline";

const count = (value: number | null) => (value === null ? "Unknown" : value.toLocaleString());
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const categories = {
  t3: "T3 instructions",
  "app-context": "App context",
  custom: "Custom instructions",
};

export function ThreadInsightsPanel({
  threadRef,
  visible,
  mode,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly mode: "loads" | "tokens";
}) {
  const [selectedRun, setSelectedRun] = useState<string>("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [evidence, setEvidence] = useState("");
  const effectiveSelection = mode === "loads" && selectedRun === "all" ? "" : selectedRun;
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    visible && canRead
      ? threadInsightsGet({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            ...(effectiveSelection === "all" ? { allRuns: true } : {}),
            ...(effectiveSelection && effectiveSelection !== "all"
              ? { runId: RunId.make(effectiveSelection) }
              : {}),
          },
        })
      : null,
  );
  const data = query.data;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      <InspectControls>
        <div className="flex w-full min-w-0 items-center gap-1">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
            <select
              aria-label="Inspect run"
              value={effectiveSelection}
              onChange={(event) => setSelectedRun(event.target.value)}
              className="h-5 min-w-0 flex-1 rounded border bg-background px-1 text-foreground"
            >
              <option value="">Latest run</option>
              {mode === "tokens" && <option value="all">All runs</option>}
              {data?.runs.toReversed().map((run) => (
                <option key={run.id} value={run.id}>
                  Run {run.ordinal}
                  {run.startedAt ? ` · ${date(run.startedAt)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <InspectRefreshButton
            label="Refresh activity"
            disabled={!canRead || query.isPending}
            onClick={() => query.refresh()}
          />
        </div>
        {mode === "loads" && (
          <>
            <div className="flex w-full min-w-0 items-center gap-1">
              <SidebarSearchField
                aria-label="Search file and skill activity"
                value={search}
                onValueChange={setSearch}
                onClear={() => setSearch("")}
                className="min-w-24"
              />
              <Menu>
                <ToolFilterMenuTrigger
                  label="Activity filters"
                  tooltip="Type and evidence"
                  active={kind !== "" || evidence !== ""}
                />
                <MenuPopup align="end">
                  <MenuGroup>
                    <MenuGroupLabel>Type</MenuGroupLabel>
                    <MenuRadioGroup value={kind} onValueChange={(next) => setKind(String(next))}>
                      {["", "file", "skill", "instructions", "search", "resource"].map((type) => (
                        <MenuRadioItem key={type} value={type}>
                          <CheckedLabel>{type === "" ? "All types" : type}</CheckedLabel>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Evidence</MenuGroupLabel>
                    <MenuRadioGroup
                      value={evidence}
                      onValueChange={(next) => setEvidence(String(next))}
                    >
                      {[
                        ["", "All evidence"],
                        ["reported", "Reported"],
                        ["inferred", "Inferred"],
                      ].map(([value, label]) => (
                        <MenuRadioItem key={value} value={value}>
                          <CheckedLabel>{label}</CheckedLabel>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            </div>
          </>
        )}
      </InspectControls>
      {!canRead ? (
        <p className="p-4 text-sm text-muted-foreground">
          This connection cannot read thread activity.
        </p>
      ) : query.error ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {query.error}
        </p>
      ) : !data ? (
        <p className="p-4 text-sm text-muted-foreground">
          {query.isPending ? "Loading activity…" : "No activity available."}
        </p>
      ) : mode === "loads" ? (
        <LoadTimeline
          events={data.loads}
          estimateMethod={data.estimateMethod}
          search={search}
          kind={kind}
          evidence={evidence}
        />
      ) : (
        <TokenDetails data={data} />
      )}
    </div>
  );
}

function LoadTimeline({
  events,
  estimateMethod,
  search,
  kind,
  evidence,
}: {
  readonly events: ReadonlyArray<ThreadLoadEvent>;
  readonly estimateMethod: string;
  readonly search: string;
  readonly kind: string;
  readonly evidence: string;
}) {
  const filtered = filterLoadEvents(events, search, kind, evidence);
  return (
    <div className="space-y-2 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {filtered.length} of {events.length} events
        </p>
        <InspectHelp label="About file and skill activity">
          <p>
            Tool activity includes failed requests. Inferred shell reads do not prove the entire
            file reached the model. Automatic provider instruction loads may be unavailable.
          </p>
          <p>Output measures tool-result text, not file size or billed input. {estimateMethod}</p>
        </InspectHelp>
      </div>
      {filtered.length ? (
        <ul aria-label="File and skill activity" className="divide-y rounded border px-2">
          {filtered.map((event) => {
            const path = event.paths[0];
            const name = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? event.label;
            const parent = path?.replace(/[\\/][^\\/]+$/, "");
            const Icon = event.kind === "skill" ? BookOpenIcon : FileTextIcon;
            return (
              <li key={event.itemId} className="min-w-0 py-1.5">
                <details className="group">
                  <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="inline-flex w-[calc(100%-1.25rem)] min-w-0 items-start gap-2 align-top">
                      <Icon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center justify-between gap-x-2">
                          <span className="min-w-0 flex-1 basis-24 truncate text-sm font-medium">
                            {event.kind === "skill" && name === "SKILL.md"
                              ? `${parent?.split(/[\\/]/).at(-1)} / ${name}`
                              : name}
                          </span>
                          <span
                            className={
                              event.status === "failed"
                                ? "shrink-0 text-xs text-destructive"
                                : "shrink-0 text-xs text-muted-foreground"
                            }
                          >
                            {event.status}
                          </span>
                        </span>
                        {event.paths.length > 1 && (
                          <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                            {event.paths
                              .slice(1)
                              .map((fullPath) => fullPath.split(/[\\/]/).filter(Boolean).at(-1))
                              .join(" · ")}
                          </span>
                        )}
                        {parent && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {parent}
                          </span>
                        )}
                        <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                          <span>{event.kind}</span>
                          <span>{event.evidence}</span>
                          <time dateTime={event.at}>
                            {new Date(event.at).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                        </span>
                      </span>
                    </span>
                  </summary>
                  <div className="mt-2 space-y-1 border-t pt-2 text-xs">
                    <p className="break-all">{event.label}</p>
                    {event.paths.map((fullPath) => (
                      <code key={fullPath} className="block break-all text-muted-foreground">
                        {fullPath}
                      </code>
                    ))}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                      <dt>Tool</dt>
                      <dd className="break-all">{event.toolName}</dd>
                      <dt>Time</dt>
                      <dd>{date(event.at)}</dd>
                      <dt>Output</dt>
                      <dd>
                        {event.outputBytes === null
                          ? "Unknown"
                          : `${count(event.outputBytes)} bytes`}
                        {event.estimatedOutputTokens !== null &&
                          ` · ~${count(event.estimatedOutputTokens)} tokens`}
                      </dd>
                    </dl>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-2 text-xs text-muted-foreground">
          {events.length
            ? "No activity matches these filters."
            : "No file or skill activity was identified for this run."}
        </p>
      )}
    </div>
  );
}

function TokenDetails({ data }: { readonly data: ThreadInsights }) {
  const usage = data.selectedRunId
    ? data.usage.filter((point) => point.runId === data.selectedRunId)
    : data.usage;
  const footprints = data.selectedRunId
    ? data.footprints.filter((point) => point.runId === data.selectedRunId)
    : data.footprints;
  const totals = reportedUsageTotals(usage);
  return (
    <div className="space-y-2 p-2">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {totals.measuredTurns} measured {totals.measuredTurns === 1 ? "turn" : "turns"} ·{" "}
            {totals.complete ? "Complete" : "Partial / unavailable"}
          </span>
          <InspectHelp label="How tokens are counted">
            <p>
              Provider-reported main-agent totals. Local commands are excluded; missing usage stays
              unknown. Other input/output covers reported subagent or compaction usage separately.
            </p>
            <p>Cache reads are included in input; reasoning is included in output.</p>
            <p className="font-medium text-foreground">Provider harness: unknown</p>
            <p>
              Hidden provider instructions are unavailable. Input also includes conversation, tools
              and files; the remainder cannot be attributed to the harness.
            </p>
          </InspectHelp>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border p-2">
            <p className="text-xs text-muted-foreground">Main input</p>
            <p className="text-lg tabular-nums">{count(totals.input)}</p>
          </div>
          <div className="rounded border p-2">
            <p className="text-xs text-muted-foreground">Main output</p>
            <p className="text-lg tabular-nums">{count(totals.output)}</p>
          </div>
        </div>
        <UsageTimeline points={usage.filter((point) => !point.localCommand)} />
        {usage.length ? (
          <details className="rounded border p-2">
            <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              Turn details · {usage.length}
            </summary>
            <div className="mt-2 divide-y">
              {usage.map((point) => (
                <details key={point.turnId} className="py-2 text-xs">
                  <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="inline-flex w-[calc(100%-1.25rem)] flex-wrap justify-between gap-2 align-top">
                      <span>Turn {point.ordinal}</span>
                      <span className="text-muted-foreground">
                        {point.localCommand
                          ? "Local command (excluded)"
                          : `${count(point.inputTokens)} in · ${count(point.outputTokens)} out`}
                      </span>
                    </span>
                  </summary>
                  <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-muted-foreground">
                    <dt>Recorded</dt>
                    <dd>{date(point.at)}</dd>
                    <dt>Status</dt>
                    <dd>{point.status}</dd>
                    {Object.entries({
                      Input: point.inputTokens,
                      Output: point.outputTokens,
                      "Cache read (input subset)": point.cachedInputTokens,
                      "Cache write": point.cacheCreationTokens,
                      "Reasoning (output subset)": point.reasoningTokens,
                      "Other input": point.otherInputTokens,
                      "Other output": point.otherOutputTokens,
                    }).map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt>{label}</dt>
                        <dd className="text-right tabular-nums">{count(value)}</dd>
                      </div>
                    ))}
                    {point.hasSubagents && (
                      <>
                        <dt>Subagents</dt>
                        <dd>Activity reported</dd>
                      </>
                    )}
                  </dl>
                </details>
              ))}
            </div>
          </details>
        ) : (
          <p className="text-sm text-muted-foreground">No provider usage recorded.</p>
        )}
      </section>
      <details className="space-y-2 rounded border p-2">
        <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          Instruction estimates ·{" "}
          {footprints.length
            ? `${footprints.length} ${footprints.length === 1 ? "snapshot" : "snapshots"}`
            : "Unavailable"}
        </summary>
        <p className="text-xs text-muted-foreground">
          Payload estimates captured at dispatch. These describe known instructions, not a breakdown
          of the billed input total. {data.estimateMethod}
        </p>
        {footprints.length ? (
          footprints.map((footprint) => (
            <div
              key={`${footprint.runId}-${footprint.attemptId}-${footprint.providerTurnOrdinal}-${footprint.capturedAt}-${footprint.providerInstanceId}-${footprint.source}`}
              className="space-y-2"
            >
              <p className="text-xs text-muted-foreground">
                {footprint.driver} · {footprint.model} · {date(footprint.capturedAt)}
                <br />
                {footprint.source}
              </p>
              <dl className="divide-y text-xs">
                {footprint.parts.map((part) => (
                  <div
                    key={part.key}
                    className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2"
                  >
                    <dt className="min-w-0 flex-1 break-words">
                      <span>{part.label}</span>
                      <span className="mt-1 block text-muted-foreground">
                        {categories[part.category]}
                      </span>
                    </dt>
                    <dd className="text-right tabular-nums">
                      <span>~{count(part.estimatedTokens)} tokens</span>
                      <span className="mt-1 block text-muted-foreground">
                        {count(part.bytes)} bytes
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))
        ) : (
          <p className="rounded border p-2 text-sm text-muted-foreground">
            No instruction snapshot was captured for this run. Historical payloads cannot be
            reconstructed reliably.
          </p>
        )}
      </details>
    </div>
  );
}

function InspectHelp({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon-micro" aria-label={label} />}>
        <CircleHelpIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact" side="bottom" align="end" aria-label={label}>
        <div className="space-y-2 text-xs text-muted-foreground">{children}</div>
      </PopoverPopup>
    </Popover>
  );
}
