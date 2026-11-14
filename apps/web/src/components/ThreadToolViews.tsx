import { Link } from "@tanstack/react-router";
import {
  AuthOrchestrationReadScope,
  ThreadId,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CheckIcon,
  ChevronLeftIcon,
  CopyIcon,
  FilesIcon,
  LightbulbIcon,
  LinkIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { configuredHostedAppUrl } from "../hostedPairing";
import { SidebarSearchField } from "./sidebar/SidebarSearchField";
import { CheckedLabel, ToolFilterMenuTrigger } from "./ToolFilterMenuTrigger";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useNowMinute } from "../hooks/useNowMinute";
import { copyThreadReference } from "../lib/copyThreadReference";
import { cn } from "../lib/utils";
import { formatElapsedDurationLabel } from "../timestampFormat";
import {
  markTimestamp,
  linksCopyText,
  matchesToolFilter,
  visibleMarks,
  type LinkSort,
} from "./threadToolFilters.logic";
import { createPortal } from "react-dom";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  useProject,
  useQuietThreadProjection,
  useThreadRelationshipShells,
  useThreadShell,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { threadMarksGet } from "../state/threadMarks";
import { useXwingEnvironmentsSupport } from "../state/xwingEnvironments";
import { talkedWithThreads, withDelegates } from "../threadContextSidebar";
import {
  useThreadContextSidebarStore,
  type ThreadContextSection,
} from "../threadContextSidebarStore";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  type DraftId,
  useComposerDraftModelState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { ThreadInspectPanel, type ThreadInspectSection } from "./insights/ThreadInspectPanel";
import { ThreadTimelineView } from "./ThreadTimelineView";
import { ToolHeaderButton } from "./threadToolsHost";
import { ThreadListView } from "./reviews/ThreadListView";
import { ArtifactsPanel } from "./reviews/ThreadWorkspacePanel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyMedia } from "./ui/empty";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useThreadEnvironmentUsage } from "./xwing/ThreadEnvironments";
import { XwingEnvironmentsPanel } from "./xwing/XwingEnvironmentsPanel";

export const sidebarWorkspaceGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "thread-context:workspace",
  tag: WS_METHODS.threadWorkspaceGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

/** Views that lay out their own padding and scrolling. */
export const FLUSH_THREAD_TOOLS: ReadonlySet<ThreadContextSection> = new Set([
  "inspect",
  "details",
  "automations",
]);

export function ThreadToolSection({
  section,
  threadRef,
  detailsRef,
  actions,
}: {
  section: Exclude<ThreadContextSection, "automations">;
  threadRef: ScopedThreadRef;
  detailsRef: (element: HTMLDivElement | null) => void;
  actions: HTMLDivElement | null;
}) {
  switch (section) {
    case "todos":
      return (
        <ThreadListView
          key={`${threadRef.environmentId}:${threadRef.threadId}`}
          threadRef={threadRef}
        />
      );
    case "artifacts":
      return <ThreadArtifacts threadRef={threadRef} />;
    case "links":
      return <ThreadLinks threadRef={threadRef} actions={actions} />;
    case "related":
      return <ThreadRelated threadRef={threadRef} />;
    case "timeline":
      return <ThreadTimelineView threadRef={threadRef} actions={actions} />;
    case "details":
      return (
        <div
          ref={detailsRef}
          className="@container group/details-destination mx-auto w-full max-w-4xl overflow-y-auto py-1"
        >
          <div className="text-xs group-has-[[data-context-thread-details]]/details-destination:hidden">
            <ThreadSummary threadRef={threadRef} />
          </div>
        </div>
      );
    case "environments":
      return <ThreadEnvironments threadRef={threadRef} />;
    case "inspect":
      return <ThreadInspect threadRef={threadRef} />;
  }
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

const useLinkPreferences = create(
  persist<{
    local: boolean;
    utc: boolean;
    service: boolean;
    description: boolean;
    hour24: boolean;
    sort: LinkSort;
    toggle: (key: "local" | "utc" | "service" | "description" | "hour24") => void;
    setSort: (sort: LinkSort) => void;
  }>(
    (set) => ({
      local: true,
      utc: false,
      service: true,
      description: true,
      hour24: false,
      sort: "newest",
      toggle: (key) => set((state) => ({ [key]: !state[key] })),
      setSort: (sort) => set({ sort }),
    }),
    // The retired Marks panel's key, so its column choices carry over.
    { name: "t3-workspace-mark-columns" },
  ),
);

function useRowCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: "link",
    onCopy: setCopied,
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Could not copy", description: error.message }),
      ),
  });
  return {
    copy: (value: string, key = value) => copyToClipboard(value, key),
    isCopied: (key: string) => isCopied && copied === key,
  };
}

export function ToolFilterInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SidebarSearchField
      aria-label={label}
      value={value}
      onValueChange={onChange}
      onClear={() => onChange("")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && value) {
          event.stopPropagation();
          onChange("");
        }
      }}
    />
  );
}

/** A row's copy button and ⋯ menu, shown on hover, focus or while the menu is open. */
function RowActions({
  label,
  copied,
  onCopy,
  copyLabel,
  children,
}: {
  label: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-tiny"
              aria-label={`${copyLabel}: ${label}`}
              onClick={onCopy}
            />
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </TooltipTrigger>
        <TooltipPopup>{copied ? "Copied" : copyLabel}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon-tiny" aria-label={`Actions for ${label}`} />}
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">{children}</MenuPopup>
      </Menu>
    </div>
  );
}

const rowClass =
  "group/row flex min-w-0 items-start gap-1 rounded-md px-1.5 py-1 hover:bg-muted/40 focus-within:bg-muted/40";

function ThreadLinks({
  threadRef,
  actions,
}: {
  threadRef: ScopedThreadRef;
  actions: HTMLDivElement | null;
}) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const shell = useThreadShell(threadRef);
  const workspace = useEnvironmentQuery(
    canRead
      ? sidebarWorkspaceGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const marks = useEnvironmentQuery(
    canRead
      ? threadMarksGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const preferences = useLinkPreferences();
  const [filter, setFilter] = useState("");
  const [service, setService] = useState("all");
  const { copy, isCopied } = useRowCopy();
  const ticketStates = workspace.data?.items.flatMap((item) => item.linkStates ?? []) ?? [];
  const tickets = [
    ...new Set(
      workspace.data?.items.flatMap((item) =>
        item.links.filter((link) => link.type === "ticket").map((link) => link.target),
      ) ?? [],
    ),
  ]
    .map((ticket) => ({
      ticket,
      state: ticketStates.find((link) => link.type === "ticket" && link.target === ticket),
    }))
    .filter(
      ({ ticket, state }) =>
        (service === "all" || service === "Ticket") &&
        matchesToolFilter([ticket, state?.title, state?.label, state?.url], filter),
    );
  const pullRequests = (shell?.pullRequests ?? []).filter(
    (pullRequest) =>
      (service === "all" || service === "Pull request") &&
      matchesToolFilter(
        [
          `${pullRequest.repository}#${pullRequest.number}`,
          pullRequest.url,
          pullRequest.snapshot?.title,
          pullRequest.snapshot?.state,
        ],
        filter,
      ),
  );
  const allMarks = marks.data ?? [];
  const rows = visibleMarks(allMarks, {
    filter,
    service,
    sort: preferences.sort,
    hour24: preferences.hour24,
  });
  const services = [...new Set(allMarks.map((mark) => mark.service))].toSorted();
  const nothing = !tickets.length && !pullRequests.length && !rows.length;
  const filtered = filter.trim() !== "" || service !== "all";
  const copyLabel = filtered ? "Copy shown links" : "Copy all links";
  const markLine = (mark: (typeof rows)[number]) =>
    [
      preferences.local ? markTimestamp(mark.timestamp, false, preferences.hour24) : "",
      preferences.utc ? `${markTimestamp(mark.timestamp, true, preferences.hour24)} UTC` : "",
      preferences.service ? mark.service : "",
      mark.url,
      preferences.description ? mark.description : "",
    ]
      .filter(Boolean)
      .join(" ");
  const copyAll = () =>
    copy(
      linksCopyText({
        tickets: tickets.map(({ ticket, state }) => ({
          ticket,
          ...(state?.label ? { label: state.label } : {}),
          ...(state?.url ? { url: state.url } : {}),
        })),
        pullRequests: pullRequests.map((pullRequest) => ({
          url: pullRequest.url,
          ...(pullRequest.snapshot?.title ? { title: pullRequest.snapshot.title } : {}),
        })),
        marks: rows.map(markLine),
      }),
      "all",
    );
  return (
    <div className="space-y-3 text-xs">
      {actions
        ? createPortal(
            <ToolHeaderButton
              label="Refresh links"
              disabled={!canRead}
              onClick={() => {
                marks.refresh();
                workspace.refresh();
              }}
            >
              <RefreshCwIcon />
            </ToolHeaderButton>,
            actions,
          )
        : null}
      {!canRead ? (
        <p className="text-muted-foreground">This connection cannot read links.</p>
      ) : (
        <div className="space-y-2">
          <ToolFilterInput label="Filter links" value={filter} onChange={setFilter} />
          <div className="flex items-center justify-end gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={copyLabel}
                    disabled={nothing}
                    onClick={copyAll}
                  />
                }
              >
                {isCopied("all") ? <CheckIcon /> : <CopyIcon />}
              </TooltipTrigger>
              <TooltipPopup>{isCopied("all") ? "Copied" : copyLabel}</TooltipPopup>
            </Tooltip>
            <Menu>
              <ToolFilterMenuTrigger
                label="Link filters"
                tooltip="Service, sort and columns"
                active={service !== "all"}
              />
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Service</MenuGroupLabel>
                  <MenuRadioGroup
                    value={service}
                    onValueChange={(next) => setService(String(next))}
                  >
                    {["all", "Ticket", "Pull request", ...services].map((name) => (
                      <MenuRadioItem key={name} value={name}>
                        <CheckedLabel>{name === "all" ? "All" : name}</CheckedLabel>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Sort links</MenuGroupLabel>
                  <MenuRadioGroup
                    value={preferences.sort}
                    onValueChange={(next) => {
                      if (
                        next === "newest" ||
                        next === "oldest" ||
                        next === "service" ||
                        next === "link"
                      )
                        preferences.setSort(next);
                    }}
                  >
                    <MenuRadioItem value="newest">
                      <CheckedLabel>Newest first</CheckedLabel>
                    </MenuRadioItem>
                    <MenuRadioItem value="oldest">
                      <CheckedLabel>Oldest first</CheckedLabel>
                    </MenuRadioItem>
                    <MenuRadioItem value="service">
                      <CheckedLabel>By service</CheckedLabel>
                    </MenuRadioItem>
                    <MenuRadioItem value="link">
                      <CheckedLabel>By link</CheckedLabel>
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Show</MenuGroupLabel>
                  {(
                    [
                      ["local", "Local time"],
                      ["utc", "UTC"],
                      ["service", "Service"],
                      ["description", "Description"],
                      ["hour24", "24-hour clock"],
                    ] as const
                  ).map(([key, label]) => (
                    <MenuCheckboxItem
                      key={key}
                      checked={preferences[key]}
                      onCheckedChange={() => preferences.toggle(key)}
                    >
                      {label}
                    </MenuCheckboxItem>
                  ))}
                </MenuGroup>
              </MenuPopup>
            </Menu>
          </div>
        </div>
      )}
      {tickets.length ? (
        <section className="space-y-1">
          <SectionHeading>Ticket</SectionHeading>
          {tickets.map(({ ticket, state }) => (
            <div key={ticket} className={cn(rowClass, "flex-col items-stretch")}>
              <div className="flex min-w-0 items-center gap-1.5">
                <a
                  href={state?.url ?? ticket}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate font-medium text-primary hover:underline"
                >
                  {ticket}
                </a>
                <Badge
                  size="sm"
                  variant={
                    state?.state === "closed"
                      ? "success"
                      : state?.state === "open"
                        ? "info"
                        : "outline"
                  }
                >
                  {state?.label ?? "Unavailable"}
                </Badge>
                <span className="flex-1" />
                <RowActions
                  label={ticket}
                  copyLabel="Copy ticket ID"
                  copied={isCopied(`ticket:${ticket}`)}
                  onCopy={() => copy(ticket, `ticket:${ticket}`)}
                >
                  <MenuItem onClick={() => copy(ticket, `ticket:${ticket}`)}>
                    Copy ticket ID
                  </MenuItem>
                  <MenuItem
                    disabled={!state?.url}
                    onClick={() => state?.url && copy(state.url, `ticket-url:${ticket}`)}
                  >
                    Copy link
                  </MenuItem>
                  {state?.title ? (
                    <MenuItem
                      onClick={() => copy(`${ticket} ${state.title}`, `ticket-title:${ticket}`)}
                    >
                      Copy ID and title
                    </MenuItem>
                  ) : null}
                  <MenuItem
                    render={<a href={state?.url ?? ticket} target="_blank" rel="noreferrer" />}
                  >
                    Open ticket
                  </MenuItem>
                </RowActions>
              </div>
              <p className="break-words leading-5 text-muted-foreground">
                {state?.title ?? "Ticket details unavailable"}
              </p>
            </div>
          ))}
        </section>
      ) : null}
      {pullRequests.length ? (
        <section className="space-y-1">
          <SectionHeading>Pull requests</SectionHeading>
          {pullRequests.map((pullRequest) => {
            const name = `${pullRequest.repository}#${pullRequest.number}`;
            return (
              <div
                key={`${pullRequest.host}/${name}`}
                className={cn(rowClass, "flex-col items-stretch")}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <a
                    href={pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate font-medium text-primary hover:underline"
                  >
                    {name}
                  </a>
                  {pullRequest.snapshot ? (
                    <Badge
                      size="sm"
                      variant={
                        pullRequest.snapshot.state === "merged"
                          ? "success"
                          : pullRequest.snapshot.state === "open"
                            ? pullRequest.snapshot.isDraft
                              ? "outline"
                              : "info"
                            : "secondary"
                      }
                    >
                      {pullRequest.snapshot.isDraft && pullRequest.snapshot.state === "open"
                        ? "draft"
                        : pullRequest.snapshot.state}
                    </Badge>
                  ) : null}
                  <span className="flex-1" />
                  <RowActions
                    label={name}
                    copyLabel="Copy link"
                    copied={isCopied(pullRequest.url)}
                    onCopy={() => copy(pullRequest.url)}
                  >
                    <MenuItem onClick={() => copy(pullRequest.url)}>Copy link</MenuItem>
                    <MenuItem onClick={() => copy(name, `pr-name:${name}`)}>Copy {name}</MenuItem>
                    {pullRequest.snapshot ? (
                      <MenuItem
                        onClick={() => copy(pullRequest.snapshot!.headBranch, `pr-branch:${name}`)}
                      >
                        Copy branch
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      render={<a href={pullRequest.url} target="_blank" rel="noreferrer" />}
                    >
                      Open pull request
                    </MenuItem>
                  </RowActions>
                </div>
                {pullRequest.snapshot ? (
                  <p className="break-words leading-5 text-muted-foreground">
                    {pullRequest.snapshot.title}
                  </p>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}
      {rows.length ? (
        <section className="space-y-1">
          <SectionHeading>From the conversation</SectionHeading>
          {rows.map((mark) => {
            const environmentId =
              mark.link?.type === "xwing_environment" ? mark.link.xwingEnvironmentId : null;
            const label = mark.name ?? mark.url.replace(/^xwing-environment:/, "Xwing ");
            const meta = [
              preferences.service ? mark.service : "",
              preferences.local ? markTimestamp(mark.timestamp, false, preferences.hour24) : "",
              preferences.utc
                ? `${markTimestamp(mark.timestamp, true, preferences.hour24)} UTC`
                : "",
            ].filter(Boolean);
            return (
              <div key={mark.url} className={rowClass}>
                <div className="min-w-0 flex-1">
                  {mark.contextSource ? (
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams({
                        environmentId: threadRef.environmentId,
                        threadId: mark.contextSource.threadId,
                      })}
                      className="block truncate text-primary hover:underline"
                    >
                      {label}
                    </Link>
                  ) : environmentId ? (
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-primary hover:underline"
                      onClick={() =>
                        useThreadContextSidebarStore
                          .getState()
                          .show("environments", { thread: threadRef, environmentId })
                      }
                    >
                      {label}
                    </button>
                  ) : (
                    <a
                      href={mark.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-primary hover:underline"
                    >
                      {label}
                    </a>
                  )}
                  {meta.length ? (
                    <p className="truncate text-3xs text-muted-foreground">{meta.join(" · ")}</p>
                  ) : null}
                  {preferences.description && mark.description ? (
                    <p className="break-words text-muted-foreground">{mark.description}</p>
                  ) : null}
                </div>
                <RowActions
                  label={label}
                  copyLabel="Copy link"
                  copied={isCopied(mark.url)}
                  onCopy={() => copy(mark.url)}
                >
                  <MenuItem onClick={() => copy(mark.url)}>Copy link</MenuItem>
                  <MenuItem onClick={() => copy(markLine(mark), `line:${mark.url}`)}>
                    Copy with details
                  </MenuItem>
                  {mark.description ? (
                    <MenuItem onClick={() => copy(mark.description, `description:${mark.url}`)}>
                      Copy description
                    </MenuItem>
                  ) : null}
                  {environmentId ? (
                    <MenuItem
                      onClick={() =>
                        useThreadContextSidebarStore
                          .getState()
                          .show("environments", { thread: threadRef, environmentId })
                      }
                    >
                      Open in Environments
                    </MenuItem>
                  ) : mark.contextSource ? null : (
                    <MenuItem render={<a href={mark.url} target="_blank" rel="noreferrer" />}>
                      Open link
                    </MenuItem>
                  )}
                </RowActions>
              </div>
            );
          })}
        </section>
      ) : null}
      {marks.error ? <p role="alert">Could not load links.</p> : null}
      {nothing && canRead ? (
        filtered ? (
          <p className="px-1.5 text-muted-foreground">No links match.</p>
        ) : (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <LinkIcon />
            </EmptyMedia>
            <EmptyDescription>
              {marks.isPending
                ? "Loading links…"
                : "The ticket, pull requests and links from the conversation appear here."}
            </EmptyDescription>
          </Empty>
        )
      ) : null}
    </div>
  );
}

function ThreadArtifacts({ threadRef }: { threadRef: ScopedThreadRef }) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const workspace = useEnvironmentQuery(
    canRead
      ? sidebarWorkspaceGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const selection = useThreadContextSidebarStore((state) => state.artifactSelection);
  const open =
    selection &&
    (selection.thread === null ||
      (selection.thread.environmentId === threadRef.environmentId &&
        selection.thread.threadId === threadRef.threadId))
      ? selection.id
      : null;
  const setOpen = (id: string | null) =>
    useThreadContextSidebarStore.getState().selectArtifact(threadRef, id);
  const [filter, setFilter] = useState("");
  const { copy, isCopied } = useRowCopy();
  const nowMinute = useNowMinute();
  if (open !== null)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setOpen(null)}>
          <ChevronLeftIcon />
          All artifacts
        </Button>
        <ArtifactsPanel
          key={open}
          inSidebar
          threadRef={threadRef}
          selectedId={open}
          workspaceMutationId={null}
          composerDraftTarget={threadRef}
        />
      </div>
    );
  const artifacts = (workspace.data?.artifacts ?? [])
    .map((artifact) => {
      const latest = artifact.versions.at(-1);
      return {
        artifact,
        latest,
        unanswered:
          latest?.questions.filter((question) => !latest.answers[question.id]?.submittedAt)
            .length ?? 0,
      };
    })
    .filter(({ artifact, latest }) =>
      matchesToolFilter([artifact.title, artifact.id, latest?.content], filter),
    )
    .toSorted(
      (left, right) =>
        right.unanswered - left.unanswered ||
        (right.latest?.createdAt ?? "").localeCompare(left.latest?.createdAt ?? ""),
    );
  const total = workspace.data?.artifacts.length ?? 0;
  if (!canRead)
    return <p className="text-xs text-muted-foreground">This connection cannot read artifacts.</p>;
  if (!workspace.data)
    return (
      <p className="text-xs text-muted-foreground">{workspace.error ?? "Loading artifacts…"}</p>
    );
  return (
    <div className="space-y-2 text-xs">
      {total ? (
        <ToolFilterInput label="Filter artifacts" value={filter} onChange={setFilter} />
      ) : null}
      {artifacts.map(({ artifact, latest, unanswered }) => (
        <div key={artifact.id} className={rowClass}>
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => setOpen(artifact.id)}
          >
            <span className="block break-words font-medium leading-5">{artifact.title}</span>
            <span className="flex flex-wrap items-center gap-x-1.5 text-3xs text-muted-foreground">
              <span>
                v{latest?.version ?? 1} · {artifact.format === "html" ? "HTML" : "Markdown"}
                {latest
                  ? ` · ${formatElapsedDurationLabel(latest.createdAt, Date.parse(`${nowMinute}:00.000Z`))}`
                  : ""}
              </span>
              {unanswered ? (
                <Badge size="sm" variant="warning">
                  {unanswered} unanswered
                </Badge>
              ) : null}
            </span>
          </button>
          <RowActions
            label={artifact.title}
            copyLabel="Copy content"
            copied={isCopied(`content:${artifact.id}`)}
            onCopy={() => latest && copy(latest.content, `content:${artifact.id}`)}
          >
            <MenuItem onClick={() => setOpen(artifact.id)}>Open</MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={!latest}
              onClick={() => latest && copy(latest.content, `content:${artifact.id}`)}
            >
              Copy content
            </MenuItem>
            <MenuItem onClick={() => copy(artifact.title, `title:${artifact.id}`)}>
              Copy title
            </MenuItem>
            <MenuItem onClick={() => copy(artifact.id, `id:${artifact.id}`)}>Copy ID</MenuItem>
          </RowActions>
        </div>
      ))}
      {!artifacts.length ? (
        total ? (
          <p className="px-1.5 text-muted-foreground">No artifacts match.</p>
        ) : (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <FilesIcon />
            </EmptyMedia>
            <EmptyDescription>
              Documents agents publish for this thread appear here.
            </EmptyDescription>
          </Empty>
        )
      ) : null}
    </div>
  );
}

function ThreadRelated({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const shells = useThreadRelationshipShells(threadRef);
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const [filter, setFilter] = useState("");
  const { copy } = useRowCopy();
  const messagedBy = new Set(
    projection?.messages.flatMap((message) => [
      ...(message.origin &&
      "threadId" in message.origin &&
      message.origin.environmentId === threadRef.environmentId
        ? [message.origin.threadId]
        : []),
      ...(message.notification?.source.kind === "thread_reply" &&
      (message.notification.source.environmentId === undefined ||
        message.notification.source.environmentId === threadRef.environmentId)
        ? [message.notification.source.threadId]
        : []),
    ]),
  );
  const talkedWith = talkedWithThreads({
    threadId: threadRef.threadId,
    self: shell,
    shells,
    messagedBy,
    transfers: projection?.contextTransfers ?? [],
  });
  const rows = withDelegates(
    talkedWith.map(({ entry, relation }) => ({
      id: entry.id,
      title: entry.title,
      branch: entry.branch ?? null,
      relation,
    })),
    projection?.subagents ?? [],
  );
  const shown = rows.filter((row) =>
    matchesToolFilter([row.title, row.relation, row.branch], filter),
  );
  const refOf = (threadId: string) =>
    scopeThreadRef(threadRef.environmentId, ThreadId.make(threadId));
  return (
    <div className="space-y-4 text-xs">
      {rows.length ? (
        <ToolFilterInput label="Filter related threads" value={filter} onChange={setFilter} />
      ) : null}
      <section className="space-y-1">
        <SectionHeading>Talked with</SectionHeading>
        {shown.map((entry) => (
          <div key={entry.id} className={rowClass}>
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(refOf(entry.id))}
              className="min-w-0 flex-1"
            >
              <span className="block text-3xs text-muted-foreground">{entry.relation}</span>
              <span className="block break-words text-primary hover:underline">{entry.title}</span>
            </Link>
            <RowActions
              label={entry.title}
              copyLabel="Copy thread link"
              copied={false}
              onCopy={() =>
                void copyThreadReference(
                  threadChipCopyTarget(refOf(entry.id), entry.title, configuredHostedAppUrl()),
                )
              }
            >
              <MenuItem
                onClick={() =>
                  void copyThreadReference(
                    threadChipCopyTarget(refOf(entry.id), entry.title, configuredHostedAppUrl()),
                  )
                }
              >
                Copy thread link
              </MenuItem>
              <MenuItem onClick={() => copy(entry.id, `id:${entry.id}`)}>Copy thread ID</MenuItem>
              {entry.branch ? (
                <MenuItem onClick={() => entry.branch && copy(entry.branch, `branch:${entry.id}`)}>
                  Copy branch
                </MenuItem>
              ) : null}
            </RowActions>
          </div>
        ))}
        {!rows.length ? (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <NetworkIcon />
            </EmptyMedia>
            <EmptyDescription>
              Threads this one delegates to, forks or messages appear here.
            </EmptyDescription>
          </Empty>
        ) : !shown.length ? (
          <p className="px-1.5 text-muted-foreground">No threads match.</p>
        ) : null}
      </section>
      <section className="space-y-2">
        <SectionHeading>Suggested</SectionHeading>
        <Empty size="compact">
          <EmptyMedia variant="icon">
            <LightbulbIcon />
          </EmptyMedia>
          <EmptyDescription>Agent-suggested related threads will appear here.</EmptyDescription>
        </Empty>
      </section>
    </div>
  );
}

function ThreadSummary({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  return (
    <div className="space-y-2 break-words">
      <p>{shell?.title ?? "Thread unavailable"}</p>
      <p className="text-muted-foreground">{shell?.worktreePath}</p>
      <p>{shell?.branch}</p>
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(threadRef)}
        className="text-primary hover:underline"
      >
        Open conversation details
      </Link>
    </div>
  );
}

function ThreadEnvironments({ threadRef }: { threadRef: ScopedThreadRef }) {
  const selection = useThreadContextSidebarStore((state) => state.environmentSelection);
  const selectedId =
    selection?.thread.environmentId === threadRef.environmentId &&
    selection.thread.threadId === threadRef.threadId
      ? selection.id
      : undefined;
  const supported = useXwingEnvironmentsSupport(threadRef.environmentId);
  const usage = useThreadEnvironmentUsage(threadRef, true);
  const shell = useThreadShell(threadRef);
  const [browseXwing, setBrowseXwing] = useState(false);
  const attached =
    shell?.developmentEnvironment != null ||
    usage.environments.length > 0 ||
    usage.missing.length > 0;
  if (supported && (attached || browseXwing || selectedId !== undefined)) {
    return (
      <XwingEnvironmentsPanel
        threadRef={threadRef}
        selectedId={selectedId}
        visible
        onSelect={(id) => useThreadContextSidebarStore.getState().selectEnvironment(threadRef, id)}
      />
    );
  }
  return (
    <div className="space-y-4 text-xs">
      <ThreadWorkspaceSummary threadRef={threadRef} />
      {supported && !usage.usage.isPending ? (
        <section className="space-y-2">
          <SectionHeading>Xwing</SectionHeading>
          <p className="text-muted-foreground">No Xwing environment is attached to this thread.</p>
          <Button variant="outline" size="sm" onClick={() => setBrowseXwing(true)}>
            Browse Xwing
          </Button>
        </section>
      ) : null}
    </div>
  );
}

function ThreadWorkspaceSummary({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const project = useProject(
    shell ? { environmentId: threadRef.environmentId, projectId: shell.projectId } : null,
  );
  const path = shell?.worktreePath ?? project?.workspaceRoot ?? null;
  return (
    <section className="space-y-2">
      <SectionHeading>Workspace</SectionHeading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">{shell?.worktreePath ? "Worktree" : "Folder"}</dt>
        <dd className="min-w-0 break-all font-mono text-3xs leading-4">{path ?? "Unavailable"}</dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="min-w-0 break-all font-mono text-3xs leading-4">
          {shell?.branch ?? "None"}
        </dd>
      </dl>
    </section>
  );
}

export function ThreadInspect({
  threadRef,
  draftId,
}: {
  threadRef: ScopedThreadRef;
  /** Set on a draft route, where the composer keys its state by draft. */
  draftId?: DraftId;
}) {
  const shell = useThreadShell(threadRef);
  const [section, setSection] = useState<ThreadInspectSection>("loads");
  const draftSession = useComposerDraftStore((store) =>
    shell !== null
      ? null
      : draftId
        ? store.getDraftSession(draftId)
        : store.getDraftSessionByRef(threadRef),
  );
  const draftModel = useComposerDraftModelState(draftId ?? threadRef);
  const provider = draftModel.activeProvider;
  const model = provider ? draftModel.modelSelectionByProvider[provider]?.model : undefined;
  return (
    <ThreadInspectPanel
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      section={section}
      onSectionChange={setSection}
      visible
      startedThread={shell !== null}
      draft={
        draftSession === null
          ? undefined
          : {
              draft: {
                projectId: draftSession.projectId,
                worktreePath: draftSession.worktreePath,
                interactionMode: draftSession.interactionMode,
              },
              ...(provider ? { providerInstanceId: provider } : {}),
              ...(model ? { model } : {}),
            }
      }
    />
  );
}
