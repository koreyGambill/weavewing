import { getClientSettings } from "~/hooks/useSettings";
import {
  AuthOrchestrationReadScope,
  AuthTerminalReadScope,
  type DevelopmentEnvironmentCleanupAssessment,
  type DevelopmentEnvironmentSetupResult,
  type DevelopmentEnvironmentThreadBlock,
  type ProjectId,
  type ScopedThreadRef,
  type XwingApplicationRun,
  type XwingEnvironmentId,
  type XwingRepairResult,
  XwingRunId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { ExternalLinkIcon, PlayIcon, ScrollTextIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import {
  attachDevelopmentEnvironment,
  cleanUpDevelopmentEnvironment,
  createDevelopmentEnvironment,
  developmentEnvironmentAppCommands,
  developmentEnvironmentAppLogs,
  developmentEnvironmentCleanupAssessment,
  repairDevelopmentEnvironment,
  restoreDevelopmentEnvironment,
  startDevelopmentEnvironmentApp,
  stopDevelopmentEnvironmentApp,
} from "../../state/developmentEnvironmentLifecycle";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openPreviewSession } from "../preview/openPreviewSession";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MiddleTruncate } from "../ui/middle-truncate";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { APP_BASE_NAME } from "~/branding";

/** A branch name suggested from an environment name; Xwing's own default can be invalid. */
function suggestedBranch(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "");
}

export function CreateEnvironmentForm({
  threadRef,
  projectId,
  onOpen,
  onCancel,
  allowOpenPartial = true,
  onPendingChange,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly onOpen: (id: XwingEnvironmentId, name: string) => void;
  readonly onCancel: () => void;
  readonly allowOpenPartial?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const environmentId = threadRef.environmentId;
  const create = useAtomCommand(createDevelopmentEnvironment, "Create Xwing environment");
  const attach = useAtomCommand(attachDevelopmentEnvironment, "Check out project");
  const canCreate = useAtomValue(createDevelopmentEnvironment.permissionAtom(environmentId));
  const [name, setName] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [pending, setPending] = useState(false);
  const [partial, setPartial] = useState<DevelopmentEnvironmentSetupResult | null>(null);
  const effectiveBranch = branch ?? suggestedBranch(name);

  const submit = async () => {
    if (partial?.failure === null) {
      onOpen(partial.xwingEnvironmentId, name.trim());
      return;
    }
    setPending(true);
    onPendingChange?.(true);
    const input = {
      projectId,
      branch: effectiveBranch,
      ...(base.trim() === "" ? {} : { base: base.trim() }),
    };
    const result = await (partial === null
      ? create({ environmentId, input: { ...input, name: name.trim() } })
      : attach({
          environmentId,
          input: { ...input, xwingEnvironmentId: partial.xwingEnvironmentId },
        }));
    setPending(false);
    onPendingChange?.(false);
    if (result._tag !== "Success") return;
    setPartial(result.value);
    if (result.value.failure === null) onOpen(result.value.xwingEnvironmentId, name.trim());
  };

  if (!canCreate) {
    return <p className="p-2 text-muted-foreground">This connection cannot create environments.</p>;
  }
  return (
    <form
      className="flex flex-col gap-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Name</span>
        <Input
          size="compact"
          value={name}
          disabled={pending || partial !== null}
          onChange={(event) => setName(event.target.value)}
          placeholder="checkout redesign"
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Branch</span>
        <Input
          size="compact"
          value={effectiveBranch}
          disabled={pending || partial?.failure === null}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="feature/checkout-redesign"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Base (optional)</span>
        <Input
          size="compact"
          value={base}
          disabled={pending || partial?.failure === null}
          onChange={(event) => setBase(event.target.value)}
          placeholder="main"
        />
      </label>
      {partial?.failure ? (
        <div className="space-y-1 rounded-md border border-warning/32 bg-warning-surface p-2">
          <p>Environment created; checking out the project failed.</p>
          <p className="text-muted-foreground">{partial.failure.message}</p>
        </div>
      ) : null}
      {pending ? (
        <p className="text-muted-foreground">
          {partial === null ? "Creating the environment and checking out" : "Checking out"}{" "}
          <span className="font-mono">{effectiveBranch}</span>. Installs can take a while.
        </p>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Button
          type="submit"
          size="compact"
          disabled={pending || effectiveBranch === "" || (partial === null && name.trim() === "")}
        >
          {partial === null
            ? "Create"
            : partial.failure === null
              ? "Use environment"
              : "Retry checkout"}
        </Button>
        {partial !== null && allowOpenPartial ? (
          <Button
            type="button"
            size="compact"
            variant="outline"
            disabled={pending}
            onClick={() => onOpen(partial.xwingEnvironmentId, name.trim())}
          >
            Open environment
          </Button>
        ) : null}
        <Button type="button" size="compact" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RepairControl({
  environmentId,
  xwingEnvironmentId,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly xwingEnvironmentId: XwingEnvironmentId;
}) {
  const repair = useAtomCommand(repairDevelopmentEnvironment, "Repair Xwing environment");
  const canRepair = useAtomValue(repairDevelopmentEnvironment.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<XwingRepairResult | null>(null);
  if (!canRepair) return null;
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <div className="flex items-center gap-1.5">
        <Button
          size="micro"
          variant="outline"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            const settled = await repair({
              environmentId,
              input: { xwingEnvironmentId },
            });
            setPending(false);
            if (settled._tag === "Success") setResult(settled.value);
          }}
        >
          {pending ? "Repairing…" : "Repair setup"}
        </Button>
        {result ? (
          <Badge size="sm" variant={result.complete ? "success" : "warning"}>
            {result.complete ? "repaired" : `exit ${result.exitCode}`}
          </Badge>
        ) : null}
      </div>
      {result?.pendingRepositories.map((pending) => (
        <p key={pending.name} className="text-muted-foreground">
          <span className="text-foreground">{pending.name}</span> not checked out: {pending.error}
        </p>
      ))}
    </div>
  );
}

const isXwingRunId = Schema.is(XwingRunId);

const isLive = (run: XwingApplicationRun) => run.status === "running" || run.status === "starting";

/** Declared commands for each repository, plus stop, open and logs for every recorded run. */
export function AppControls({
  threadRef,
  xwingEnvironmentId,
  repositories,
  runs,
  onChanged,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly xwingEnvironmentId: XwingEnvironmentId;
  readonly repositories: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<XwingApplicationRun>;
  readonly onChanged: () => void;
}) {
  const environmentId = threadRef.environmentId;
  const canOperate = useAtomValue(startDevelopmentEnvironmentApp.permissionAtom(environmentId));
  return (
    <div className="flex flex-col">
      {canOperate
        ? repositories.map((repository) => (
            <RepositoryCommands
              key={repository}
              environmentId={environmentId}
              xwingEnvironmentId={xwingEnvironmentId}
              repository={repository}
              onStarted={onChanged}
            />
          ))
        : null}
      {runs.length === 0 ? (
        <p className="px-2 py-1 text-muted-foreground">No app runs recorded.</p>
      ) : (
        runs.map((run) => (
          <RunRow
            key={run.id}
            threadRef={threadRef}
            xwingEnvironmentId={xwingEnvironmentId}
            run={run}
            canOperate={canOperate}
            onStopped={onChanged}
          />
        ))
      )}
    </div>
  );
}

function RepositoryCommands({
  environmentId,
  xwingEnvironmentId,
  repository,
  onStarted,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly xwingEnvironmentId: XwingEnvironmentId;
  readonly repository: string;
  readonly onStarted: () => void;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const commands = useEnvironmentQuery(
    canRead
      ? developmentEnvironmentAppCommands({
          environmentId,
          input: { xwingEnvironmentId, repository },
        })
      : null,
  );
  const start = useAtomCommand(startDevelopmentEnvironmentApp, "Start app");
  const [starting, setStarting] = useState<string | null>(null);
  if (commands.data === null || commands.data.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 py-1">
      <span className="shrink-0 text-muted-foreground">{repository}</span>
      {commands.data.map((command) => (
        <Tooltip key={command.name}>
          <TooltipTrigger
            render={
              <Button
                size="micro"
                variant="outline"
                disabled={starting !== null}
                onClick={async () => {
                  setStarting(command.name);
                  await start({
                    environmentId,
                    input: {
                      xwingEnvironmentId,
                      repository,
                      ...(command.name === "run" ? {} : { command: command.name }),
                    },
                  });
                  setStarting(null);
                  onStarted();
                }}
              />
            }
          >
            <PlayIcon />
            {starting === command.name ? `${command.name}…` : command.name}
          </TooltipTrigger>
          <TooltipPopup>
            {command.description ?? `Start ${command.name} in the background`}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

function RunRow({
  threadRef,
  xwingEnvironmentId,
  run,
  canOperate,
  onStopped,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly xwingEnvironmentId: XwingEnvironmentId;
  readonly run: XwingApplicationRun;
  readonly canOperate: boolean;
  readonly onStopped: () => void;
}) {
  const environmentId = threadRef.environmentId;
  const stop = useAtomCommand(stopDevelopmentEnvironmentApp, "Stop app");
  const openPreview = useAtomCommand(previewEnvironment.open, "Open app in browser");
  const canPreview = useAtomValue(previewEnvironment.open.permissionAtom(environmentId));
  const canReadLogs = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const [stopping, setStopping] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const variant =
    run.status === "exited" && run.exitCode !== undefined && run.exitCode !== 0
      ? "error"
      : isLive(run)
        ? "success"
        : "outline";
  // App URLs are local to the server, so they open in its browser panel, which also works remotely.
  const open = async (url: string) => {
    const result = await openPreviewSession({ openPreview, threadRef, url });
    if (result._tag === "Success") {
      useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId, {
        destination: getClientSettings().linkTileDestination,
      });
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2 py-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Badge size="sm" variant={variant}>
          {run.status}
          {run.exitCode !== undefined ? ` ${run.exitCode}` : null}
        </Badge>
        <span className="shrink-0 font-medium">{run.name}</span>
        <span className="min-w-0 truncate text-muted-foreground">{run.repository}</span>
        {run.startedAt ? (
          <span className="shrink-0 text-muted-foreground">
            <RelativeTime timestamp={run.startedAt} />
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {canReadLogs && isXwingRunId(run.id) ? (
            <IconAction
              label={showLogs ? "Hide logs" : "Show logs"}
              onClick={() => setShowLogs((shown) => !shown)}
            >
              <ScrollTextIcon />
            </IconAction>
          ) : null}
          {canOperate && isLive(run) ? (
            <IconAction
              label="Stop"
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                await stop({
                  environmentId,
                  input: { xwingEnvironmentId, runId: run.id },
                });
                setStopping(false);
                onStopped();
              }}
            >
              <SquareIcon />
            </IconAction>
          ) : null}
        </span>
      </div>
      {isLive(run)
        ? Object.entries(run.urls).map(([name, url]) => (
            <span key={name} className="flex min-w-0 items-center gap-1 pl-1 text-muted-foreground">
              <span className="shrink-0">{name}</span>
              {canPreview ? (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1 font-mono text-foreground hover:underline"
                  onClick={() => void open(url)}
                >
                  <span className="min-w-0 truncate">{url}</span>
                  <ExternalLinkIcon className="size-3 shrink-0" />
                </button>
              ) : (
                <span className="min-w-0 truncate font-mono">{url}</span>
              )}
            </span>
          ))
        : null}
      {showLogs && isXwingRunId(run.id) ? (
        <RunLogs
          environmentId={environmentId}
          xwingEnvironmentId={xwingEnvironmentId}
          runId={run.id}
        />
      ) : null}
    </div>
  );
}

function RunLogs({
  environmentId,
  xwingEnvironmentId,
  runId,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly xwingEnvironmentId: XwingEnvironmentId;
  readonly runId: typeof XwingRunId.Type;
}) {
  const logs = useEnvironmentQuery(
    developmentEnvironmentAppLogs({
      environmentId,
      input: { xwingEnvironmentId, runId, limit: 100 },
    }),
  );
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-muted-foreground">
        {logs.data
          ? `${logs.data.records.length} of ${logs.data.matched} lines${logs.data.truncated ? ", newest" : ""}`
          : (logs.error ?? "Reading logs…")}
        <IconAction label="Read again" disabled={logs.isPending} onClick={logs.refresh}>
          <RefreshIcon refreshing={logs.isPending} />
        </IconAction>
      </div>
      {logs.data && logs.data.records.length > 0 ? (
        <pre className="max-h-60 overflow-auto rounded-sm bg-muted/40 p-1 font-mono text-2xs whitespace-pre-wrap break-words">
          {logs.data.records.map((record) => (
            <span
              key={record.sequence}
              className={record.stream === "stderr" ? "text-destructive" : undefined}
            >
              {record.text.endsWith("\n") ? record.text : `${record.text}\n`}
            </span>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function IconAction(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
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

const BLOCK_LABELS: Record<DevelopmentEnvironmentThreadBlock, string> = {
  working: "is running a turn or waiting on a request",
  "background-work": "has background agents or commands running",
  "terminal-command": "has a command running in its terminal",
  unsettled: "still works here and is not settled",
};

/** Reasons the cleanup is blocked, in the order a person resolves them. */
function cleanupReasons(assessment: DevelopmentEnvironmentCleanupAssessment) {
  return [
    ...assessment.threads.flatMap((thread) =>
      thread.block === null ? [] : [`${thread.title} ${BLOCK_LABELS[thread.block]}`],
    ),
    ...assessment.schedules.map((task) => `Schedule "${task.title}" would run here`),
    ...assessment.foreignHolds.map((hold) => `Held by ${hold.owner}: ${hold.label}`),
    ...assessment.xwingBlockers,
  ];
}

export function CleanupReview({
  environmentId,
  xwingEnvironmentId,
  onDeleted,
  archived = false,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly xwingEnvironmentId: XwingEnvironmentId;
  readonly onDeleted: () => void;
  readonly archived?: boolean;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canClean = useAtomValue(cleanUpDevelopmentEnvironment.permissionAtom(environmentId));
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const cleanUp = useAtomCommand(
    cleanUpDevelopmentEnvironment,
    confirming === "archive" ? "Archive Xwing environment" : "Delete Xwing environment",
  );
  const assessment = useEnvironmentQuery(
    reviewing && canRead
      ? developmentEnvironmentCleanupAssessment({
          environmentId,
          input: { xwingEnvironmentId },
        })
      : null,
  );
  if (!canRead) return null;
  if (!reviewing) {
    return (
      <div className="px-2 py-1">
        <Button size="micro" variant="outline" onClick={() => setReviewing(true)}>
          Review cleanup
        </Button>
      </div>
    );
  }
  const data = assessment.data;
  if (data === null) {
    return (
      <p className="px-2 py-1 text-muted-foreground">
        {assessment.error ?? "Checking threads, schedules, holds and every checkout…"}
      </p>
    );
  }
  const reasons = cleanupReasons(data);
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1">
      <div className="flex items-center gap-1.5">
        <Badge size="sm" variant={data.canClean ? "success" : "warning"}>
          {data.canClean ? "safe to delete" : "blocked"}
        </Badge>
        <span className="text-muted-foreground">
          checked <RelativeTime timestamp={data.assessedAt} />
        </span>
        <IconAction
          label="Check again"
          disabled={assessment.isPending}
          onClick={() => {
            setConfirming(null);
            assessment.refresh();
          }}
        >
          <RefreshIcon refreshing={assessment.isPending} />
        </IconAction>
      </div>
      {reasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {data.threads.length > 0 ? (
        <div className="text-muted-foreground">
          <p>Thread history stays in {APP_BASE_NAME}:</p>
          <ul className="pl-2">
            {data.threads.map((thread) => (
              <li key={thread.threadId} className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-foreground">{thread.title}</span>
                {thread.current ? null : <span className="shrink-0">moved on</span>}
                {thread.archivedAt ? <span className="shrink-0">archived</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.runningApps.length > 0 ? (
        <p className="text-muted-foreground">
          Stops {data.runningApps.map((run) => run.name).join(", ")}.
        </p>
      ) : null}
      {data.retainedPaths.length > 0 ? (
        <div className="text-muted-foreground">
          <p>Branches stay in each source repository. Xwing keeps:</p>
          {data.retainedPaths.map((retained) => (
            <span key={retained} className="flex min-w-0 font-mono">
              <MiddleTruncate value={retained} />
            </span>
          ))}
        </div>
      ) : null}
      {data.canClean && canClean ? (
        <div className="flex items-center gap-1.5">
          {confirming !== null ? (
            <>
              <Button
                size="micro"
                variant={confirming === "delete" ? "destructive" : "outline"}
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  const result = await cleanUp({
                    environmentId,
                    input: {
                      xwingEnvironmentId,
                      fingerprint: data.fingerprint,
                      action: confirming,
                    },
                  });
                  setDeleting(false);
                  setConfirming(null);
                  if (result._tag === "Success") onDeleted();
                  else assessment.refresh();
                }}
              >
                {deleting
                  ? "Working…"
                  : `${confirming === "delete" ? "Delete" : "Archive"} ${data.name}`}
              </Button>
              <Button size="micro" variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {!archived ? (
                <Button size="micro" variant="outline" onClick={() => setConfirming("archive")}>
                  Archive environment…
                </Button>
              ) : null}
              <Button
                size="micro"
                variant="destructive-outline"
                onClick={() => setConfirming("delete")}
              >
                Delete environment…
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RestoreControl({
  threadRef,
  xwingEnvironmentId,
  onRestored,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly xwingEnvironmentId: XwingEnvironmentId;
  readonly onRestored: () => void;
}) {
  const restore = useAtomCommand(restoreDevelopmentEnvironment, "Restore Xwing environment");
  const canRestore = useAtomValue(
    restoreDevelopmentEnvironment.permissionAtom(threadRef.environmentId),
  );
  const [pending, setPending] = useState(false);
  if (!canRestore) return null;
  return (
    <div className="p-2">
      <Button
        size="compact"
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const result = await restore({
            environmentId: threadRef.environmentId,
            input: { xwingEnvironmentId },
          });
          setPending(false);
          if (result._tag === "Success") onRestored();
        }}
      >
        {pending ? "Restoring…" : "Restore environment"}
      </Button>
    </div>
  );
}
