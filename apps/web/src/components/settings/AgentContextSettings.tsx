import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentContextError,
  AuthFilesystemReadScope,
  AuthSettingsWriteScope,
  type AgentContextGetInput,
  type AgentContextInstruction,
  type AgentContextReadInput,
  type AgentContextOverview,
  type AgentContextRepo,
  type AgentContextSkill,
  DEFAULT_LOAD_WATCHERS,
  type DefaultContextItem,
  type EnvironmentId,
  type LoadWatcher,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  agentContextCommit,
  agentContextGet,
  agentContextRead,
  agentContextSave,
} from "../../state/agentContext";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadDefaultContextGet, threadDefaultContextItem } from "../../state/threadInsights";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatBytes, formatTokens, homeOf, shortenPath } from "../insights/defaultContext.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  agentContextTotals,
  groupSkills,
  joinSegments,
  pendingCommits,
  splitGenerated,
  watcherErrors,
} from "./agentContext.logic";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const SCOPE_LABELS: Record<AgentContextInstruction["scope"], string> = {
  global: "user",
  project: "project",
  rule: "rule",
  import: "@ import",
  link: "linked",
};
const PREVIEW_THREAD_ID = ThreadId.make("agent-context-preview");
const sourceElementId = (realPath: string) => `agent-context-source:${realPath}`;
const focusElement = (element: HTMLElement | null) => {
  element?.scrollIntoView({ block: "center" });
  element?.focus({ preventScroll: true });
};
const focusSource = (realPath: string) =>
  focusElement(document.getElementById(sourceElementId(realPath)));

export function AgentContextSettings({
  provider,
  projectId,
  worktree,
  source,
}: {
  readonly provider?: string | undefined;
  readonly projectId?: string | undefined;
  /** The thread's checkout, which instruction files and skills are discovered from. */
  readonly worktree?: string | undefined;
  /** A source's path to scroll to once it loads. */
  readonly source?: string | undefined;
}) {
  const { scope, environment } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsScopeNotice target="environment">
        Choose one environment to see the context its agents load.
      </SettingsScopeNotice>
    );
  }
  if (environment.connection.phase !== "connected") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Agent context">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect to {environment.label} to see the context its agents load.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <EnvironmentAgentContext
      key={environment.environmentId}
      environmentId={environment.environmentId}
      initialProvider={provider}
      initialProjectId={projectId}
      initialWorktree={worktree}
      focusPath={source}
    />
  );
}

function EnvironmentAgentContext({
  environmentId,
  initialProvider,
  initialProjectId,
  initialWorktree,
  focusPath,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialProvider: string | undefined;
  readonly initialProjectId: string | undefined;
  readonly initialWorktree: string | undefined;
  readonly focusPath: string | undefined;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.archivedAt,
  );
  const providers = (useEnvironmentProviders().get(environmentId) ?? []).filter(
    (entry) => entry.enabled,
  );
  const [providerId, setProviderId] = useState(initialProvider);
  const [projectId, setProjectId] = useState(initialProjectId);
  const provider =
    providers.find((entry) => entry.instanceId === providerId) ??
    providers.find((entry) => entry.instanceId === "claudeAgent") ??
    providers[0];
  const project = projects.find((entry) => entry.id === projectId) ?? projects[0];
  // The linked thread's checkout applies only while its project stays selected.
  const worktree =
    initialWorktree !== undefined && project?.id === initialProjectId ? initialWorktree : undefined;
  const input =
    provider && project
      ? {
          providerInstanceId: ProviderInstanceId.make(provider.instanceId),
          projectId: ProjectId.make(project.id),
          ...(worktree === undefined ? {} : { worktreePath: worktree }),
        }
      : null;
  const query = useEnvironmentQuery(input ? agentContextGet({ environmentId, input }) : null);
  const overview = query.data;
  const [showCompiled, setShowCompiled] = useState(false);
  const providerLabel = (entry: (typeof providers)[number]) =>
    entry.displayName ?? entry.instanceId;

  const middle = (
    <>
      <LoadWatchersSection environmentId={environmentId} />
      {input !== null && (
        <SettingsSection
          title="Compiled"
          headerAction={
            <Button
              size="xs"
              variant="outline"
              aria-expanded={showCompiled}
              onClick={() => setShowCompiled((value) => !value)}
            >
              {showCompiled ? "Hide compiled" : "View compiled"}
            </Button>
          }
        >
          {showCompiled ? (
            <CompiledView environmentId={environmentId} input={input} overview={overview ?? null} />
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              What a new session receives for this provider and project, in order.
            </p>
          )}
        </SettingsSection>
      )}
    </>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Agent context"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={input === null}
            onClick={() => query.refresh()}
            aria-label="Refresh agent context"
          >
            <RefreshCwIcon />
            Refresh
          </Button>
        }
      >
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor="agent-context-provider">Provider</Label>
            <Select
              value={provider?.instanceId ?? ""}
              onValueChange={(value) => {
                if (value) setProviderId(value);
              }}
            >
              <SelectTrigger id="agent-context-provider">
                <SelectValue>{provider ? providerLabel(provider) : "No providers"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {providers.map((entry) => (
                  <SelectItem key={entry.instanceId} value={entry.instanceId}>
                    {providerLabel(entry)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor="agent-context-project">Project</Label>
            <Select
              value={project?.id ?? ""}
              onValueChange={(value) => {
                if (value) setProjectId(value);
              }}
            >
              <SelectTrigger id="agent-context-project">
                <SelectValue>{project?.title ?? "No projects"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Every file and skill that shapes what a new session receives
          {overview?.cwd ? ` in ${overview.cwd}` : ""}. Saving writes the real file a link points
          to; commit each repository separately.
        </p>
        {query.error && (
          <p role="alert" className="px-4 py-3 text-sm text-destructive-foreground">
            {query.error}
          </p>
        )}
        {input !== null && overview == null && !query.error && (
          <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
            Loading sources…
          </p>
        )}
        {overview?.notes.map((note) => (
          <p key={note} className="px-4 py-2 text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </SettingsSection>
      {overview != null && input !== null ? (
        <AgentContextSections
          environmentId={environmentId}
          target={input}
          overview={overview}
          focusPath={focusPath}
          onSaved={() => query.refresh()}
        >
          {middle}
        </AgentContextSections>
      ) : (
        middle
      )}
    </SettingsPageContainer>
  );
}

/** Instructions and the standards index, then `children`, then commits and the long skill list. */
function AgentContextSections({
  environmentId,
  target,
  overview,
  focusPath,
  onSaved,
  children,
}: {
  readonly environmentId: EnvironmentId;
  /** The provider, project and checkout the overview came from; reads and writes reuse it. */
  readonly target: DiscoveryTarget;
  readonly overview: AgentContextOverview;
  readonly focusPath: string | undefined;
  readonly onSaved: () => void;
  readonly children: ReactNode;
}) {
  const canSave = useAtomValue(agentContextSave.permissionAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const [editing, setEditing] = useState<{
    realPath: string;
    title: string;
    editable: boolean;
    opener: HTMLElement;
  } | null>(null);
  const [committing, setCommitting] = useState<{ root: string; opener: HTMLElement } | null>(null);
  // Files a commit left out, stated beside their repository until the next commit there.
  const [leftOut, setLeftOut] = useState<ReadonlyMap<string, ReadonlyArray<string>>>(new Map());
  const totals = agentContextTotals(overview);
  const home = homeOf([
    ...overview.instructions.map((file) => file.realPath),
    ...overview.skills.map((skill) => skill.realPath),
  ]);
  const generated = overview.instructions.filter(
    (file, index, all) =>
      file.generated.length > 0 &&
      all.findIndex((other) => other.realPath === file.realPath) === index,
  );
  const commits = pendingCommits(overview);
  const repoOf = (root: string | null) =>
    root === null ? undefined : overview.repos.find((repo) => repo.root === root);
  const canEdit = canSave && canRead;
  const open = (source: SourceFields, title: string) => (opener: HTMLElement) =>
    setEditing({ realPath: source.realPath, title, editable: source.editable && canEdit, opener });

  return (
    <>
      <SettingsSection
        title="Instructions"
        headerAction={
          overview.instructionsSupported ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              ~{formatTokens(totals.sessionTokens)} tok/session
            </span>
          ) : undefined
        }
      >
        {!overview.instructionsSupported ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            T3 does not resolve instruction files for this provider.
          </p>
        ) : overview.instructions.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No instruction files load for this project.
          </p>
        ) : (
          overview.instructions.map((file) => (
            <SourceRow
              key={`${file.path}:${file.scope}`}
              title={shortenPath(file.path, home)}
              tags={[
                SCOPE_LABELS[file.scope],
                ...(file.generated.length > 0 ? ["generated block"] : []),
              ]}
              source={file}
              focus={focusPath === file.path || focusPath === file.realPath}
              repo={repoOf(file.repoRoot)}
              home={home}
              depth={file.depth}
              tokens={
                file.status === "expected"
                  ? `~${formatTokens(file.estimatedTokens)} tok${file.scope === "link" ? " on demand" : ""}`
                  : file.status === "secret"
                    ? "credential or state file, not read"
                    : "outside the instruction folders, not read"
              }
              canEdit={canEdit}
              canRead={canRead}
              onOpen={open(file, shortenPath(file.path, home))}
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection title="Standards index">
        {generated.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No generated standards block in these files.
          </p>
        ) : (
          generated.map((file) => (
            <div key={file.realPath} className="px-4 py-3 text-sm">
              <button
                type="button"
                className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => focusSource(file.realPath)}
              >
                {shortenPath(file.realPath, home)}
              </button>
              <p className="text-xs text-muted-foreground">
                Generated{" "}
                {file.generated
                  .map((range) => `lines ${range.startLine}–${range.endLine}`)
                  .join(", ")}
                . Edit the cards; regenerate with overwing standards export.
              </p>
            </div>
          ))
        )}
      </SettingsSection>
      {children}
      {/* Always present, so a save never inserts a section above the rows below it. */}
      <SettingsSection title="Uncommitted edits">
        {commits.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No uncommitted changes in these sources.
          </p>
        ) : (
          commits.map((repo) => (
            <div key={repo.root} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{shortenPath(repo.root, home)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {repo.dirty.length}
                  {repo.dirtyTruncated ? "+" : ""} changed{" "}
                  {repo.dirty.length === 1 ? "file" : "files"}
                  {repo.branch ? ` on ${repo.branch}` : " on a detached HEAD"}
                </span>
                {(leftOut.get(repo.root)?.length ?? 0) > 0 && (
                  <span className="block text-xs text-warning-foreground">
                    Left uncommitted: {leftOut.get(repo.root)!.join(", ")}
                  </span>
                )}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={(event) => setCommitting({ root: repo.root, opener: event.currentTarget })}
              >
                Commit…
              </Button>
            </div>
          ))
        )}
      </SettingsSection>
      <SettingsSection
        title={`Skills (${overview.skills.length})`}
        headerAction={
          overview.skillsSupport === "unsupported" ? undefined : (
            <span className="text-xs text-muted-foreground tabular-nums">
              listing ~{formatTokens(totals.listingTokens)} tok/turn
              {overview.skillsSupport === "estimate" ? " (estimate)" : ""}
              {totals.duplicates > 0 ? `, ${totals.duplicates} duplicated` : ""}
            </span>
          )
        }
      >
        {overview.skillsSupport === "unsupported" ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            This provider reports no skills to T3 here.
          </p>
        ) : (
          groupSkills(overview.skills).map((group) => (
            <div key={group.label}>
              <h3 className="px-4 pt-3 pb-1 text-3xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.label}
                {group.skills[0]?.origin.detail ? ` · ${group.skills[0].origin.detail}` : ""}
              </h3>
              {group.skills.map((skill) => (
                <SkillRow
                  key={`${skill.name}:${skill.path}`}
                  skill={skill}
                  focus={focusPath === skill.path || focusPath === skill.realPath}
                  repo={repoOf(skill.repoRoot)}
                  home={home}
                  canEdit={canEdit}
                  canRead={canRead}
                  onOpen={open(skill, skill.name)}
                />
              ))}
            </div>
          ))
        )}
      </SettingsSection>
      {editing !== null && (
        <SourceEditor
          environmentId={environmentId}
          target={target}
          realPath={editing.realPath}
          title={editing.title}
          editable={editing.editable}
          opener={editing.opener}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
      {committing !== null && (
        <CommitDialog
          environmentId={environmentId}
          target={target}
          repo={commits.find((entry) => entry.root === committing.root)}
          opener={committing.opener}
          home={home}
          onClose={() => setCommitting(null)}
          onCommitted={(root, left) => {
            setLeftOut((current) => new Map(current).set(root, left));
            onSaved();
          }}
        />
      )}
    </>
  );
}

type SourceFields = Pick<
  AgentContextSkill,
  | "realPath"
  | "linked"
  | "bytes"
  | "repoRoot"
  | "modified"
  | "editable"
  | "readable"
  | "readOnlyReason"
>;

/** Edit for a source this connection may change, View for any other readable one. */
function OpenButton({
  source,
  canEdit,
  canRead,
  label,
  onOpen,
}: {
  readonly source: SourceFields;
  readonly canEdit: boolean;
  readonly canRead: boolean;
  readonly label: string;
  readonly onOpen: (opener: HTMLElement) => void;
}) {
  const edits = source.editable && canEdit;
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={`${edits ? "Edit" : "View"} ${label}`}
      disabled={!source.readable || !canRead}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {edits ? "Edit" : "View"}
    </Button>
  );
}

function RepoState({
  source,
  repo,
  home,
}: {
  readonly source: SourceFields;
  readonly repo: AgentContextRepo | undefined;
  readonly home: string | null;
}) {
  return repo === undefined ? (
    <span>not in a git repository</span>
  ) : (
    <>
      <span>{shortenPath(repo.root, home)}</span>
      <Badge size="sm" variant={source.modified ? "warning" : "success"}>
        {source.modified ? "modified" : "clean"}
      </Badge>
    </>
  );
}

function SourceRow({
  title,
  tags,
  source,
  focus,
  repo,
  home,
  depth,
  tokens,
  canEdit,
  canRead,
  onOpen,
}: {
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly source: SourceFields;
  /** Scrolls the row into view when it mounts, for links from a thread's Context panel. */
  readonly focus: boolean;
  readonly repo: AgentContextRepo | undefined;
  readonly home: string | null;
  readonly depth: number;
  readonly tokens: string;
  readonly canEdit: boolean;
  readonly canRead: boolean;
  readonly onOpen: (opener: HTMLElement) => void;
}) {
  return (
    <div
      id={sourceElementId(source.realPath)}
      ref={focus ? focusElement : undefined}
      tabIndex={-1}
      className="flex items-start gap-3 px-4 py-2.5 outline-none focus-visible:bg-muted"
      style={depth > 0 ? { paddingLeft: `${16 + depth * 12}px` } : undefined}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          {tags.map((tag) => (
            <Badge key={tag} size="sm" variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {source.linked ? "→ " : ""}
          {shortenPath(source.realPath, home)}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <RepoState source={source} repo={repo} home={home} />
          <span className="tabular-nums">
            · {formatBytes(source.bytes)} · {tokens}
          </span>
        </p>
        {!source.editable && source.readOnlyReason && (
          <p className="text-xs text-muted-foreground">Read-only: {source.readOnlyReason}</p>
        )}
      </div>
      <OpenButton
        source={source}
        canEdit={canEdit}
        canRead={canRead}
        label={title}
        onOpen={onOpen}
      />
    </div>
  );
}

/** One line per skill; the real path, repository and size open below it. */
function SkillRow({
  skill,
  focus,
  repo,
  home,
  canEdit,
  canRead,
  onOpen,
}: {
  readonly skill: AgentContextSkill;
  readonly focus: boolean;
  readonly repo: AgentContextRepo | undefined;
  readonly home: string | null;
  readonly canEdit: boolean;
  readonly canRead: boolean;
  readonly onOpen: (opener: HTMLElement) => void;
}) {
  const [expanded, setExpanded] = useState(focus);
  const state = skill.shadowed ? "shadowed" : skill.unlisted;
  return (
    <div
      id={sourceElementId(skill.realPath)}
      ref={focus ? focusElement : undefined}
      tabIndex={-1}
      className="px-4 py-1 outline-none focus-visible:bg-muted"
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
          />
          <span className="min-w-0 truncate text-sm">{skill.name}</span>
          {state && (
            <Badge size="sm" variant="outline">
              {state}
            </Badge>
          )}
          {skill.modified && (
            <Badge size="sm" variant="warning">
              modified
            </Badge>
          )}
          {skill.duplicates.length > 0 && (
            <Badge size="sm" variant="warning" className="min-w-0 shrink">
              <span className="truncate">also {skill.duplicates.join(", ")}</span>
            </Badge>
          )}
        </button>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {skill.listed ? `~${formatTokens(skill.listingTokens)} tok/turn` : "0 tok"}
        </span>
        <OpenButton
          source={skill}
          canEdit={canEdit}
          canRead={canRead}
          label={skill.name}
          onOpen={onOpen}
        />
      </div>
      {expanded && (
        <div className="space-y-0.5 pt-0.5 pb-1 pl-5 text-xs text-muted-foreground">
          <p className="break-all">
            {skill.linked ? `${shortenPath(skill.path, home)} → ` : ""}
            {shortenPath(skill.realPath, home)}
          </p>
          <p className="flex flex-wrap items-center gap-1.5">
            <RepoState source={skill} repo={repo} home={home} />
            <span className="tabular-nums">· {formatBytes(skill.bytes)}</span>
          </p>
          {state === "user-only" && <p>Only you can invoke it; the model never sees it listed.</p>}
          {state === "off" && <p>Turned off in the provider's settings.</p>}
          {state === "shadowed" && <p>Another skill with this name loads instead.</p>}
          {!skill.editable && skill.readOnlyReason && <p>Read-only: {skill.readOnlyReason}</p>}
        </div>
      )}
    </div>
  );
}

type DiscoveryTarget = AgentContextGetInput;

function SourceEditor({
  environmentId,
  target,
  realPath,
  title,
  editable,
  opener,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: DiscoveryTarget;
  readonly realPath: string;
  readonly title: string;
  /** False opens the text read-only, with no Save. */
  readonly editable: boolean;
  /** Takes focus back when the dialog closes. */
  readonly opener: HTMLElement;
  readonly onClose: () => void;
  readonly onSaved: (realPath: string) => void;
}) {
  const input = { ...target, realPath };
  const read = useEnvironmentQuery(agentContextRead({ environmentId, input }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl" finalFocus={() => opener}>
        <DialogHeader>
          <DialogTitle>
            {editable ? "Edit" : "View"} {title}
          </DialogTitle>
          <DialogDescription className="break-all">
            {editable ? "Saves to" : "Read-only:"} {realPath}
          </DialogDescription>
        </DialogHeader>
        {read.error ? (
          <DialogPanel>
            <p role="alert" className="text-sm text-destructive-foreground">
              {read.error}
            </p>
          </DialogPanel>
        ) : read.data == null ? (
          <DialogPanel>
            <p role="status" className="text-sm text-muted-foreground">
              Loading…
            </p>
          </DialogPanel>
        ) : editable ? (
          <EditorBody
            key={read.data.sha256}
            environmentId={environmentId}
            input={input}
            text={read.data.text}
            sha256={read.data.sha256}
            generated={read.data.generated}
            onReload={() => read.refresh()}
            onClose={onClose}
            onSaved={() => onSaved(realPath)}
          />
        ) : (
          <>
            <DialogPanel>
              <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words">
                {read.data.text}
              </pre>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function EditorBody({
  environmentId,
  input,
  text,
  sha256,
  generated,
  onReload,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: AgentContextReadInput;
  readonly text: string;
  readonly sha256: string;
  readonly generated: Parameters<typeof splitGenerated>[1];
  readonly onReload: () => void;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const save = useAtomCommand(agentContextSave, { reportFailure: false });
  const [segments, setSegments] = useState(() => splitGenerated(text, generated));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; conflict: boolean } | null>(null);
  const contents = joinSegments(segments);
  return (
    <>
      <DialogPanel>
        <div className="grid gap-2">
          {segments.map((segment, index) =>
            segment.generated ? (
              <div key={segment.start} className="grid gap-1">
                <p className="text-xs text-muted-foreground">
                  Generated by overwing. Edit the cards; regenerate with overwing standards export.
                </p>
                <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                  {segment.text}
                </pre>
              </div>
            ) : (
              <Textarea
                key={segment.start}
                aria-label={index === 0 ? "File text" : `File text, part ${index + 1}`}
                rows={14}
                value={segment.text}
                onChange={(event) => {
                  const value = event.target.value;
                  setSegments((current) =>
                    current.map((entry, at) => (at === index ? { ...entry, text: value } : entry)),
                  );
                }}
              />
            ),
          )}
        </div>
      </DialogPanel>
      <DialogFooter>
        {/* In the footer, clamped to the buttons' height, so a failure never moves Save. */}
        <p
          role="alert"
          className="mr-auto line-clamp-2 min-w-0 flex-1 text-xs text-destructive-foreground"
        >
          {failure?.message}
        </p>
        {failure?.conflict && (
          <Button variant="outline" onClick={onReload}>
            Reload, discarding my edits
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={pending || contents === text}
          onClick={async () => {
            setPending(true);
            setFailure(null);
            const result = await save({
              environmentId,
              input: { ...input, contents, expectedSha256: sha256 },
            });
            setPending(false);
            if (result._tag === "Success") {
              onSaved();
              onClose();
              return;
            }
            setFailure(commandError(result));
          }}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

const isAgentContextError = Schema.is(AgentContextError);

/** The server's message for a failed command, and whether the file or HEAD moved. */
function commandError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return isAgentContextError(error)
    ? { message: error.message, conflict: error.reason === "conflict" }
    : { message: error instanceof Error ? error.message : "The request failed.", conflict: false };
}

function CommitDialog({
  environmentId,
  target,
  repo,
  home,
  opener,
  onClose,
  onCommitted,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: DiscoveryTarget;
  readonly repo: AgentContextRepo | undefined;
  readonly home: string | null;
  readonly opener: HTMLElement;
  readonly onClose: () => void;
  /** `left` names the changed files the commit did not include. */
  readonly onCommitted: (root: string, left: ReadonlyArray<string>) => void;
}) {
  const commit = useAtomCommand(agentContextCommit, { reportFailure: false });
  const canCommit = useAtomValue(agentContextCommit.permissionAtom(environmentId));
  const [message, setMessage] = useState("");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const files = repo?.dirty ?? [];
  const chosen = files.filter((file) => !excluded.has(file.path));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg" finalFocus={() => opener}>
        <DialogHeader>
          <DialogTitle>Commit {repo ? shortenPath(repo.root, home) : "changes"}</DialogTitle>
          <DialogDescription>
            Commits the checked files by path. Anything already staged that you leave unchecked
            stays staged. Undo with git revert.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <div className="grid max-h-72 overflow-y-auto rounded-md border">
              {files.map((file) => (
                <label
                  key={file.path}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 not-last:border-b"
                >
                  <Checkbox
                    checked={!excluded.has(file.path)}
                    onCheckedChange={(checked) =>
                      setExcluded((current) => {
                        const next = new Set(current);
                        if (checked) next.delete(file.path);
                        else next.add(file.path);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{file.path}</span>
                    {file.untracked && (
                      <span className="block text-xs text-muted-foreground">
                        untracked: commit it, or move or delete it
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            {repo?.dirtyTruncated && (
              <p className="text-xs text-muted-foreground">
                Only the first {files.length} changed files are listed; commit the rest in a
                terminal.
              </p>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="agent-context-commit-message">Commit message</Label>
              <Textarea
                id="agent-context-commit-message"
                value={message}
                placeholder="docs: tighten agent instructions"
                onChange={(event) => setMessage(event.target.value)}
              />
            </div>
            {!canCommit && (
              <p className="text-xs text-muted-foreground">
                Committing needs source control permission on this environment.
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <p
            role="alert"
            className="mr-auto line-clamp-2 min-w-0 flex-1 text-xs text-destructive-foreground"
          >
            {failure}
          </p>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !canCommit ||
              busy ||
              repo === undefined ||
              chosen.length === 0 ||
              message.trim() === ""
            }
            onClick={async () => {
              if (repo === undefined) return;
              setBusy(true);
              setFailure(null);
              const result = await commit({
                environmentId,
                input: {
                  ...target,
                  repoRoot: repo.root,
                  realPaths: chosen.map((file) => `${repo.root}/${file.path}`),
                  message: message.trim(),
                  expectedHead: repo.head,
                },
              });
              setBusy(false);
              if (result._tag === "Success") {
                onCommitted(
                  repo.root,
                  files.filter((file) => excluded.has(file.path)).map((file) => file.path),
                );
                onClose();
                return;
              }
              setFailure(commandError(result).message);
            }}
          >
            Commit
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type WatcherRow = LoadWatcher & { readonly id: string };
/** Ids come from content, so the same saved list keeps its row keys across renders. */
const toRows = (watchers: ReadonlyArray<LoadWatcher>): ReadonlyArray<WatcherRow> => {
  const seen = new Map<string, number>();
  return watchers.map((watcher) => {
    const base = `${watcher.kind}:${watcher.label}:${watcher.match}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { ...watcher, id: `${base}:${count}` };
  });
};
const toWatchers = (rows: ReadonlyArray<WatcherRow>): ReadonlyArray<LoadWatcher> =>
  rows.map(({ label, kind, match }) => ({ label, kind, match }));
const sameWatchers = (left: ReadonlyArray<LoadWatcher>, right: ReadonlyArray<LoadWatcher>) =>
  JSON.stringify(toWatchers(left as ReadonlyArray<WatcherRow>)) ===
  JSON.stringify(toWatchers(right as ReadonlyArray<WatcherRow>));

function LoadWatchersSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.loadWatchers);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const savedRows = toRows(saved);
  const [draft, setDraft] = useState<ReadonlyArray<WatcherRow> | null>(null);
  const watchers = draft ?? savedRows;
  const errors = watcherErrors(watchers);
  const dirty = draft !== null && !sameWatchers(draft, saved);
  const update = (id: string, patch: Partial<LoadWatcher>) =>
    setDraft(watchers.map((watcher) => (watcher.id === id ? { ...watcher, ...patch } : watcher)));
  return (
    <SettingsSection
      title="Load watchers"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWrite || watchers.length >= 32}
          onClick={() =>
            setDraft([
              ...watchers,
              {
                label: "",
                kind: "command",
                match: "",
                id: `new:${Date.now()}:${watchers.length}`,
              },
            ])
          }
        >
          <PlusIcon />
          Add watcher
        </Button>
      }
    >
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Tool calls that match a watcher show in a thread's Inspect › Loads as knowledge loads, under
        the watcher's label. A shell command watcher matches when its words appear in that order in
        the command. A tool watcher matches the tool's name; * stands for any run of characters.
      </p>
      {watchers.length === 0 && (
        <p className="px-4 py-3 text-xs text-muted-foreground">No watchers; nothing is recorded.</p>
      )}
      {watchers.map((watcher, index) => (
        <div key={watcher.id} className="grid gap-1 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Watcher ${index + 1} label`}
              className="w-32"
              value={watcher.label}
              disabled={!canWrite}
              placeholder="Label"
              onChange={(event) => update(watcher.id, { label: event.target.value })}
            />
            <Select
              value={watcher.kind}
              disabled={!canWrite}
              onValueChange={(value) => {
                if (value === "command" || value === "tool") update(watcher.id, { kind: value });
              }}
            >
              <SelectTrigger aria-label={`Watcher ${index + 1} kind`} className="w-36">
                <SelectValue>
                  {watcher.kind === "command" ? "Shell command" : "Tool name"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="command">Shell command</SelectItem>
                <SelectItem value="tool">Tool name</SelectItem>
              </SelectPopup>
            </Select>
            <Input
              aria-label={`Watcher ${index + 1} match`}
              aria-invalid={errors[index] !== null}
              className="min-w-48 flex-1"
              font="mono"
              value={watcher.match}
              disabled={!canWrite}
              placeholder={watcher.kind === "command" ? "overwing search" : "mcp__vault__*"}
              onChange={(event) => update(watcher.id, { match: event.target.value })}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove watcher ${index + 1}`}
              disabled={!canWrite}
              onClick={() => setDraft(watchers.filter((entry) => entry.id !== watcher.id))}
            >
              <XIcon />
            </Button>
          </div>
          {errors[index] && (
            <p role="alert" className="text-xs text-destructive-foreground">
              {errors[index]}
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
        {!canWrite && (
          <p className="mr-auto text-xs text-muted-foreground">
            Changing watchers needs settings permission.
          </p>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={!canWrite || sameWatchers(watchers, DEFAULT_LOAD_WATCHERS)}
          onClick={() => setDraft(toRows(DEFAULT_LOAD_WATCHERS))}
        >
          Reset to default
        </Button>
        <Button size="xs" variant="outline" disabled={!dirty} onClick={() => setDraft(null)}>
          Discard
        </Button>
        <Button
          size="xs"
          disabled={!canWrite || !dirty || errors.some((error) => error !== null)}
          onClick={() =>
            updateSettings(
              {
                loadWatchers: watchers.map((watcher) => ({
                  ...watcher,
                  label: watcher.label.trim(),
                  match: watcher.match.trim(),
                })),
              },
              { onSaved: () => setDraft(null) },
            )
          }
        >
          Save watchers
        </Button>
      </div>
    </SettingsSection>
  );
}

const CATEGORY_NAMES: Record<DefaultContextItem["category"], string> = {
  t3: "T3 instructions",
  "app-context": "App context",
  custom: "Custom append",
  files: "Instruction file",
  skills: "Skill listing",
  tools: "T3 tool",
};

function CompiledView({
  environmentId,
  input,
  overview,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: DiscoveryTarget;
  readonly overview: AgentContextOverview | null;
}) {
  const request = {
    threadId: PREVIEW_THREAD_ID,
    providerInstanceId: input.providerInstanceId,
    draft: {
      projectId: input.projectId,
      worktreePath: input.worktreePath ?? null,
      interactionMode: "default" as const,
    },
  };
  const query = useEnvironmentQuery(threadDefaultContextGet({ environmentId, input: request }));
  const preview = query.data;
  if (query.error)
    return (
      <p role="alert" className="px-4 py-3 text-sm text-destructive-foreground">
        {query.error}
      </p>
    );
  if (preview == null)
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
        Loading…
      </p>
    );
  const loaded = preview.items.filter((item) => item.counted);
  const home = homeOf(preview.cwd ? [preview.cwd] : []);
  const realPathOf = (item: DefaultContextItem) =>
    item.category === "files"
      ? overview?.instructions.find((file) => file.path === item.label)?.realPath
      : item.category === "skills"
        ? overview?.skills.find((skill) => item.id === `skill:${skill.name}:${skill.path}`)
            ?.realPath
        : undefined;
  return (
    <ol className="grid">
      {loaded.map((item, index) => (
        <CompiledItem
          key={item.id}
          home={home}
          position={index + 1}
          item={item}
          environmentId={environmentId}
          request={request}
          realPath={realPathOf(item)}
        />
      ))}
    </ol>
  );
}

function CompiledItem({
  home,
  position,
  item,
  environmentId,
  request,
  realPath,
}: {
  readonly home: string | null;
  readonly position: number;
  readonly item: DefaultContextItem;
  readonly environmentId: EnvironmentId;
  readonly request: Parameters<typeof threadDefaultContextGet>[0]["input"];
  readonly realPath: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="grid gap-1 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-6 text-xs text-muted-foreground tabular-nums">{position}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{shortenPath(item.label, home)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          ~{formatTokens(item.estimatedTokens)} tok
        </span>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          disabled={!item.readable}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide text" : "Show text"}
        </Button>
      </div>
      <p className="pl-8 text-xs text-muted-foreground">
        {CATEGORY_NAMES[item.category]} · {item.source}
        {realPath !== undefined && (
          <>
            {" · "}
            <button
              type="button"
              className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => focusSource(realPath)}
            >
              Go to source
            </button>
          </>
        )}
      </p>
      {open && <CompiledText environmentId={environmentId} request={request} itemId={item.id} />}
    </li>
  );
}

function CompiledText({
  environmentId,
  request,
  itemId,
}: {
  readonly environmentId: EnvironmentId;
  readonly request: Parameters<typeof threadDefaultContextGet>[0]["input"];
  readonly itemId: string;
}) {
  const query = useEnvironmentQuery(
    threadDefaultContextItem({ environmentId, input: { ...request, itemId } }),
  );
  if (query.error)
    return (
      <p role="alert" className="pl-8 text-xs">
        Could not load this text.
      </p>
    );
  if (query.data == null) return <p className="pl-8 text-xs text-muted-foreground">Loading…</p>;
  return (
    <pre className="ml-8 max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words">
      {query.data.text}
      {query.data.truncated ? "\n… truncated" : ""}
    </pre>
  );
}
