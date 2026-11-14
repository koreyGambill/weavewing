import { ThreadEnvironmentRows, useThreadEnvironmentUsage } from "./ThreadEnvironments";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import {
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  XwingEnvironmentId,
  type XwingEnvironmentDetail,
  type XwingEnvironmentSummary,
  type XwingRepositoryDetail,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ArrowLeftIcon, Boxes, PlusIcon, TerminalSquareIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell } from "../../state/entities";
import { useEnvironment, useEnvironmentMachines } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import {
  developmentEnvironmentUsage,
  useXwingEnvironmentsSupport,
  xwingEnvironmentInspect,
  xwingEnvironmentsList,
} from "../../state/xwingEnvironments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Empty, EmptyMedia, EmptyDescription } from "../ui/empty";
import { SidebarSearchField } from "../sidebar/SidebarSearchField";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AppControls,
  CleanupReview,
  CreateEnvironmentForm,
  RepairControl,
  RestoreControl,
} from "./XwingEnvironmentLifecycle";
import { filterXwingEnvironments, xwingEnvironmentLabel } from "./xwingEnvironments.logic";

const isXwingEnvironmentId = Schema.is(XwingEnvironmentId);

export function XwingEnvironmentsPanel({
  threadRef,
  onSelect,
  selectedId,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onSelect: (id: string | null) => void;
  readonly selectedId: string | undefined;
  readonly visible: boolean;
}) {
  const environmentId = threadRef.environmentId;
  const supported = useXwingEnvironmentsSupport(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const [query, setQuery] = useState("");
  const [allEnvironments, setAllEnvironments] = useState(false);
  const linked = useThreadEnvironmentUsage(threadRef, visible);
  const shell = useThreadShell(threadRef);
  const draftWorktreePath = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef)?.worktreePath ?? null,
  );
  const draftProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef)?.projectId ?? null,
  );
  const projectId = shell?.projectId ?? draftProjectId;
  const [creating, setCreating] = useState(false);
  const currentWorkspacePath = shell?.worktreePath ?? draftWorktreePath;
  const validSelection = selectedId !== undefined && isXwingEnvironmentId(selectedId);
  const enabled = visible && supported && canRead;
  // The catalog is cheap and says whether a selection is archived, which live inspection cannot.
  const list = useEnvironmentQuery(
    enabled ? xwingEnvironmentsList({ environmentId, input: {} }) : null,
  );
  const archived = validSelection
    ? list.data?.find(
        (environment) => environment.id === selectedId && environment.status === "archived",
      )
    : undefined;
  const inspecting = validSelection && archived === undefined;
  const detail = useEnvironmentQuery(
    enabled && inspecting
      ? xwingEnvironmentInspect({ environmentId, input: { id: selectedId } })
      : null,
  );
  const select = (id: string | null) => {
    setCreating(false);
    onSelect(id);
  };
  const active = inspecting ? detail : list;
  const refresh = () => {
    list.refresh();
    linked.refresh();
    if (inspecting) detail.refresh();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-xs">
      <div className="flex min-h-7 shrink-0 flex-wrap items-center gap-1 border-b border-border px-1 py-0.5">
        {validSelection ? (
          <ToolbarButton label="All environments" onClick={() => select(null)}>
            <ArrowLeftIcon />
          </ToolbarButton>
        ) : null}
        <MachineLabel environmentId={environmentId} />
        {validSelection ? (
          <span className="min-w-0 flex-1 truncate font-medium">
            {archived
              ? xwingEnvironmentLabel(archived)
              : detail.data
                ? xwingEnvironmentLabel(detail.data)
                : null}
          </span>
        ) : (
          <SidebarSearchField
            aria-label="Filter environments"
            value={query}
            onValueChange={setQuery}
            onClear={() => setQuery("")}
            className="min-w-32"
          />
        )}
        {enabled && !validSelection ? (
          <Button size="micro" variant="ghost" onClick={() => setAllEnvironments((all) => !all)}>
            {allEnvironments ? "Linked" : "All"}
          </Button>
        ) : null}
        {enabled && !validSelection && projectId !== null ? (
          <ToolbarButton label="New environment" onClick={() => setCreating(true)}>
            <PlusIcon />
          </ToolbarButton>
        ) : null}
        {enabled ? (
          <ToolbarButton
            label={inspecting ? "Inspect again" : "Refresh"}
            disabled={active.isPending}
            onClick={refresh}
          >
            <RefreshIcon refreshing={active.isPending} />
          </ToolbarButton>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!supported ? (
          <Notice>Update this machine's T3 Code server to list Xwing environments.</Notice>
        ) : !canRead ? (
          <Notice>This connection cannot read environments.</Notice>
        ) : creating && projectId !== null && !validSelection ? (
          <CreateEnvironmentForm
            threadRef={threadRef}
            projectId={projectId}
            onOpen={(id) => {
              list.refresh();
              select(id);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : selectedId !== undefined && !validSelection ? (
          <Notice>This tab points at an environment id Xwing does not use.</Notice>
        ) : active.failure !== null || active.error !== null ? (
          <FailureNotice failure={active.failure} fallback={active.error} />
        ) : archived ? (
          <ArchivedEnvironmentDetail
            environment={archived}
            cleanup={
              <>
                <RestoreControl
                  threadRef={threadRef}
                  xwingEnvironmentId={archived.id}
                  onRestored={refresh}
                />
                <CleanupReview
                  archived
                  environmentId={environmentId}
                  xwingEnvironmentId={archived.id}
                  onDeleted={() => {
                    list.refresh();
                    select(null);
                  }}
                />
              </>
            }
          />
        ) : validSelection ? (
          detail.data ? (
            <EnvironmentDetail
              threadRef={threadRef}
              detail={detail.data}
              currentWorkspacePath={currentWorkspacePath}
              onChanged={refresh}
              onDeleted={() => {
                list.refresh();
                select(null);
              }}
            />
          ) : (
            <Notice>Inspecting…</Notice>
          )
        ) : !allEnvironments ? (
          <ThreadEnvironmentRows threadRef={threadRef} query={query} onSelect={select} />
        ) : list.data === null ? (
          <Notice>Loading…</Notice>
        ) : (
          <EnvironmentList
            environments={filterXwingEnvironments(list.data, query)}
            total={list.data.length}
            currentWorkspacePath={currentWorkspacePath}
            onSelect={select}
          />
        )}
        {enabled && validSelection ? (
          <EnvironmentThreads environmentId={environmentId} xwingEnvironmentId={selectedId} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every thread that has worked in this environment, read from the server's usage history, so
 * settled, archived and unloaded threads appear, and so do environments Xwing no longer lists.
 */
function EnvironmentThreads({
  environmentId,
  xwingEnvironmentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly xwingEnvironmentId: XwingEnvironmentId;
}) {
  const navigate = useNavigate();
  const usage = useEnvironmentQuery(
    developmentEnvironmentUsage({ environmentId, input: { xwingEnvironmentId } }),
  );
  const rows = usage.data ?? [];
  const recorded = rows[0];
  return (
    <Section title="Threads" {...(usage.data === null ? {} : { count: rows.length })}>
      {usage.error !== null ? (
        <p className="px-2 py-1 text-destructive">{usage.error}</p>
      ) : usage.data === null ? (
        <p className="px-2 py-1 text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-1 text-muted-foreground">No thread has worked here yet.</p>
      ) : (
        <>
          {recorded ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="flex min-w-0 px-2 font-mono text-muted-foreground" />}
              >
                <MiddleTruncate value={recorded.checkoutPath} />
              </TooltipTrigger>
              <TooltipPopup>
                Last recorded as{" "}
                {xwingEnvironmentLabel({
                  number: recorded.number ?? undefined,
                  name: recorded.name,
                })}{" "}
                at {recorded.checkoutPath}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {rows.map((row) => (
            <button
              key={`${row.threadId}:${row.repositorySource}`}
              type="button"
              className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left hover:bg-accent"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(environmentId, row.threadId)),
                })
              }
            >
              <Tooltip>
                <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                  {row.threadTitle}
                </TooltipTrigger>
                <TooltipPopup>{row.threadTitle}</TooltipPopup>
              </Tooltip>
              {row.current ? (
                <Badge size="sm" variant="success">
                  here now
                </Badge>
              ) : null}
              {row.archivedAt !== null ? (
                <Badge size="sm" variant="outline">
                  archived
                </Badge>
              ) : row.settledAt !== null ? (
                <Badge size="sm" variant="outline">
                  settled
                </Badge>
              ) : null}
              <RelativeTime timestamp={row.lastSelectedAt} />
            </button>
          ))}
        </>
      )}
    </Section>
  );
}

function ToolbarButton(props: {
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

function MachineLabel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const machine = useEnvironmentMachines().get(environmentId) ?? "server";
  const label = environment?.label ?? "This machine";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex shrink-0 items-center px-1 text-muted-foreground" />}
      >
        <EnvironmentMachineIcon kind={machine} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>Xwing on {label}</TooltipPopup>
    </Tooltip>
  );
}

function Notice({ children }: { readonly children: React.ReactNode }) {
  return <p className="p-2 text-muted-foreground">{children}</p>;
}

function FailureNotice({
  failure,
  fallback,
}: {
  readonly failure: unknown;
  readonly fallback: string | null;
}) {
  const message =
    failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
  const cause =
    failure !== null && typeof failure === "object" && "cause" in failure ? failure.cause : null;
  const detail =
    cause instanceof Error
      ? cause.message.trim()
      : cause !== null &&
          typeof cause === "object" &&
          "message" in cause &&
          typeof cause.message === "string"
        ? cause.message.trim()
        : "";
  return (
    <div className="space-y-1 p-2">
      <p className="text-destructive">{message ?? "Xwing could not be read."}</p>
      {detail ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

function EnvironmentList({
  environments,
  total,
  currentWorkspacePath,
  onSelect,
}: {
  readonly environments: ReadonlyArray<XwingEnvironmentSummary>;
  readonly total: number;
  readonly currentWorkspacePath: string | null;
  readonly onSelect: (id: string) => void;
}) {
  if (total === 0)
    return (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <Boxes />
        </EmptyMedia>
        <EmptyDescription>Environments created on this machine appear here.</EmptyDescription>
      </Empty>
    );
  if (environments.length === 0) return <Notice>No environment matches.</Notice>;
  return (
    <ul className="divide-y divide-border">
      {environments.map((environment) => (
        <li key={environment.id}>
          <button
            type="button"
            className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
            onClick={() => onSelect(environment.id)}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Boxes className="size-3 shrink-0 text-muted-foreground" />
              <span
                className={
                  environment.status === "archived"
                    ? "min-w-0 truncate font-medium text-muted-foreground"
                    : "min-w-0 truncate font-medium"
                }
              >
                {xwingEnvironmentLabel(environment)}
              </span>
              {environment.ticket ? (
                <Badge size="sm" variant="outline">
                  {environment.ticket}
                </Badge>
              ) : null}
              {environment.status === "archived" ? (
                <ArchivedBadge environment={environment} />
              ) : null}
            </span>
            {environment.repositories.length === 0 ? (
              <span className="pl-4.5 text-muted-foreground">No repositories yet</span>
            ) : null}
            {environment.repositories.map((repository) => (
              <span
                key={repository.path}
                className="flex min-w-0 items-center gap-1.5 pl-4.5 text-muted-foreground"
              >
                <span className="shrink-0 text-foreground/80">{repository.name}</span>
                <span className="min-w-0 truncate font-mono">{repository.branch}</span>
                {environment.status === "active" && !repository.present ? (
                  <Badge size="sm" variant="error">
                    missing
                  </Badge>
                ) : null}
                {environment.status === "active" && repository.path === currentWorkspacePath ? (
                  <Badge size="sm" variant="info">
                    this thread
                  </Badge>
                ) : null}
              </span>
            ))}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ArchivedBadge({ environment }: { readonly environment: XwingEnvironmentSummary }) {
  return (
    <Badge size="sm" variant="secondary">
      archived
      {environment.archivedAt ? (
        <>
          {" "}
          <RelativeTime timestamp={environment.archivedAt} />
        </>
      ) : null}
    </Badge>
  );
}

/** Built from the catalog alone: an archived environment has no live checkout to inspect. */
function ArchivedEnvironmentDetail({
  environment,
  cleanup,
}: {
  readonly environment: XwingEnvironmentSummary;
  readonly cleanup: React.ReactNode;
}) {
  return (
    <div className="divide-y divide-border">
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 text-muted-foreground">
        {environment.ticket ? (
          <Badge size="sm" variant="outline">
            {environment.ticket}
          </Badge>
        ) : null}
        <ArchivedBadge environment={environment} />
        <span>
          created <RelativeTime timestamp={environment.createdAt} />
        </span>
        <Tooltip>
          <TooltipTrigger render={<span className="flex min-w-0 font-mono" />}>
            <MiddleTruncate value={environment.rootPath} />
          </TooltipTrigger>
          <TooltipPopup>Archived copy kept by Xwing; threads do not run here.</TooltipPopup>
        </Tooltip>
      </div>
      <Section title="Repositories" count={environment.repositories.length}>
        {environment.repositories.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground">No repositories.</p>
        ) : (
          environment.repositories.map((repository) => (
            <div key={repository.path} className="flex flex-col gap-0.5 px-2 py-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-medium">{repository.name}</span>
                <span className="min-w-0 truncate font-mono">{repository.branch}</span>
              </div>
              <span className="flex min-w-0 font-mono text-muted-foreground">
                <MiddleTruncate value={repository.sourcePath} />
              </span>
            </div>
          ))
        )}
      </Section>
      <Section title="Cleanup">{cleanup}</Section>
    </div>
  );
}

const HEALTH_VARIANT = {
  healthy: "success",
  ok: "success",
  attention: "warning",
  error: "error",
} as const;

function healthVariant(status: string) {
  return HEALTH_VARIANT[status as keyof typeof HEALTH_VARIANT] ?? "outline";
}

function EnvironmentDetail({
  threadRef,
  detail,
  currentWorkspacePath,
  onChanged,
  onDeleted,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly detail: XwingEnvironmentDetail;
  readonly currentWorkspacePath: string | null;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
}) {
  const terminals = useThreadTerminalActions(threadRef);
  const canTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const problems = detail.health.checks.filter((check) => check.status !== "ok");
  return (
    <div className="divide-y divide-border">
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 text-muted-foreground">
        {detail.ticket ? (
          <Badge size="sm" variant="outline">
            {detail.ticket}
          </Badge>
        ) : null}
        {detail.status ? <span>{detail.status}</span> : null}
        {detail.lifecycle ? (
          <span>
            {detail.lifecycle.action}
            {detail.lifecycle.dueAt ? (
              <>
                {" "}
                {detail.lifecycle.due ? "due" : "at"} {detail.lifecycle.dueAt.slice(0, 10)}
              </>
            ) : null}
            {detail.lifecycle.blocked ? ` · blocked: ${detail.lifecycle.blocked}` : null}
          </span>
        ) : null}
        <span>
          updated <RelativeTime timestamp={detail.updatedAt} />
        </span>
        <span className="flex min-w-0 font-mono">
          <MiddleTruncate value={detail.rootPath} />
        </span>
      </div>
      <Section title="Repositories" count={detail.repositories.length}>
        {detail.repositories.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground">No repositories yet.</p>
        ) : (
          detail.repositories.map((repository) => (
            <RepositoryRow
              key={repository.path}
              repository={repository}
              current={repository.path === currentWorkspacePath}
              onOpenTerminal={
                canTerminal
                  ? () =>
                      terminals.launchTerminal({
                        location: { cwd: repository.path, worktreePath: currentWorkspacePath },
                        place: (terminalId) =>
                          useRightPanelStore.getState().openTerminal(threadRef, terminalId, {
                            cwd: repository.path,
                            worktreePath: currentWorkspacePath,
                          }),
                      })
                  : undefined
              }
            />
          ))
        )}
      </Section>
      <Section
        title="Setup health"
        trailing={
          <Badge size="sm" variant={healthVariant(detail.health.status)}>
            {detail.health.status}
          </Badge>
        }
      >
        {problems.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground">
            {detail.health.checks.length} checks passed
          </p>
        ) : (
          problems.map((check) => (
            <div
              key={`${check.code}:${check.repository ?? ""}`}
              className="flex min-w-0 items-baseline gap-1.5 px-2 py-0.5"
            >
              <Badge size="sm" variant={healthVariant(check.status)}>
                {check.status}
              </Badge>
              <span className="shrink-0 font-mono">{check.code}</span>
              {check.repository ? (
                <span className="shrink-0 text-muted-foreground">{check.repository}</span>
              ) : null}
              <span className="min-w-0 break-words text-muted-foreground">{check.message}</span>
            </div>
          ))
        )}
        {problems.length > 0 || detail.repositories.length === 0 ? (
          <RepairControl environmentId={threadRef.environmentId} xwingEnvironmentId={detail.id} />
        ) : null}
      </Section>
      <Section
        title="Apps"
        count={detail.applications.runs.length}
        trailing={
          detail.applications.truncated ? (
            <span className="text-muted-foreground">recent runs only</span>
          ) : null
        }
      >
        <AppControls
          threadRef={threadRef}
          xwingEnvironmentId={detail.id}
          repositories={detail.repositories.map((repository) => repository.name)}
          runs={detail.applications.runs}
          onChanged={onChanged}
        />
      </Section>
      <Section title="Cleanup">
        <CleanupReview
          environmentId={threadRef.environmentId}
          xwingEnvironmentId={detail.id}
          onDeleted={onDeleted}
        />
      </Section>
    </div>
  );
}

function Section(props: {
  readonly title: string;
  readonly count?: number;
  readonly trailing?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="py-1">
      <h3 className="flex items-center gap-1.5 px-2 py-0.5 font-medium text-muted-foreground">
        {props.title}
        {props.count === undefined ? null : <span className="opacity-70">{props.count}</span>}
        <span className="ml-auto">{props.trailing}</span>
      </h3>
      {props.children}
    </section>
  );
}

function RepositoryRow({
  repository,
  current,
  onOpenTerminal,
}: {
  readonly repository: XwingRepositoryDetail;
  readonly current: boolean;
  readonly onOpenTerminal?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-medium">{repository.name}</span>
        <span className="min-w-0 truncate font-mono">
          {repository.branch}
          <span className="text-muted-foreground"> ← {repository.base}</span>
        </span>
        {repository.ahead > 0 || repository.behind > 0 ? (
          <span className="shrink-0 font-mono text-muted-foreground">
            ↑{repository.ahead} ↓{repository.behind}
          </span>
        ) : null}
        <Badge size="sm" variant={repository.dirty ? "warning" : "outline"}>
          {repository.dirty ? "dirty" : "clean"}
        </Badge>
        {repository.published ? (
          <Badge size="sm" variant="secondary">
            pushed
          </Badge>
        ) : null}
        {repository.stale ? (
          <Badge size="sm" variant="warning">
            stale
          </Badge>
        ) : null}
        {current ? (
          <Badge size="sm" variant="info">
            this thread
          </Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <span className="flex min-w-0 font-mono">
          <MiddleTruncate value={repository.path} />
        </span>
        {repository.headRevision ? (
          <span className="shrink-0 font-mono opacity-70">
            {repository.headRevision.slice(0, 10)}
          </span>
        ) : null}
      </div>
      {onOpenTerminal ? (
        <div>
          <Button size="micro" variant="outline" onClick={onOpenTerminal}>
            <TerminalSquareIcon />
            Open terminal here
          </Button>
        </div>
      ) : null}
      {repository.refreshResult ? (
        <div className="text-muted-foreground">
          refresh {repository.refreshResult}
          {repository.refreshReason ? `: ${repository.refreshReason}` : null}
        </div>
      ) : null}
    </div>
  );
}
