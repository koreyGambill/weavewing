import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentContextError,
  AuthFilesystemReadScope,
  AuthSettingsWriteScope,
  type AgentContextInstruction,
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
import { PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

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
  source,
}: {
  readonly provider?: string | undefined;
  readonly projectId?: string | undefined;
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
      focusPath={source}
    />
  );
}

function EnvironmentAgentContext({
  environmentId,
  initialProvider,
  initialProjectId,
  focusPath,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialProvider: string | undefined;
  readonly initialProjectId: string | undefined;
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
  const input =
    provider && project
      ? {
          providerInstanceId: ProviderInstanceId.make(provider.instanceId),
          projectId: ProjectId.make(project.id),
        }
      : null;
  const query = useEnvironmentQuery(input ? agentContextGet({ environmentId, input }) : null);
  const overview = query.data;
  const [showCompiled, setShowCompiled] = useState(false);
  const providerLabel = (entry: (typeof providers)[number]) =>
    entry.displayName ?? entry.instanceId;

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
          Every file and skill that shapes what a new session receives. Saving writes the real file
          a link points to; commit each repository separately.
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
      {overview != null && input !== null && (
        <AgentContextSections
          environmentId={environmentId}
          overview={overview}
          focusPath={focusPath}
          onSaved={() => query.refresh()}
        />
      )}
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
    </SettingsPageContainer>
  );
}

function AgentContextSections({
  environmentId,
  overview,
  focusPath,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly overview: AgentContextOverview;
  readonly focusPath: string | undefined;
  readonly onSaved: () => void;
}) {
  const canSave = useAtomValue(agentContextSave.permissionAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const [editing, setEditing] = useState<{
    realPath: string;
    title: string;
    opener: HTMLElement;
  } | null>(null);
  const [committing, setCommitting] = useState<{ root: string; opener: HTMLElement } | null>(null);
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
  const edit = (realPath: string, title: string) => (opener: HTMLElement) =>
    setEditing({ realPath, title, opener });
  const editable = canSave && canRead;

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
              canEdit={editable}
              onEdit={edit(file.realPath, shortenPath(file.path, home))}
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
              <h3 className="px-4 pt-3 text-3xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.label}
                {group.skills[0]?.origin.detail ? ` · ${group.skills[0].origin.detail}` : ""}
              </h3>
              {group.skills.map((skill) => (
                <SourceRow
                  key={`${skill.name}:${skill.path}`}
                  title={skill.name}
                  tags={[
                    ...(skill.shadowed ? ["shadowed"] : []),
                    ...(!skill.listed && !skill.shadowed ? ["not listed"] : []),
                  ]}
                  warning={
                    skill.duplicates.length > 0 ? `also ${skill.duplicates.join(", ")}` : undefined
                  }
                  source={skill}
                  focus={focusPath === skill.path || focusPath === skill.realPath}
                  repo={repoOf(skill.repoRoot)}
                  home={home}
                  depth={0}
                  tokens={skill.listed ? `~${formatTokens(skill.listingTokens)} tok/turn` : "0 tok"}
                  canEdit={editable}
                  onEdit={edit(skill.realPath, skill.name)}
                />
              ))}
            </div>
          ))
        )}
      </SettingsSection>
      {commits.length > 0 && (
        <SettingsSection title="Uncommitted edits">
          {commits.map(({ repo, realPaths }) => (
            <div key={repo.root} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{shortenPath(repo.root, home)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {realPaths.length} modified {realPaths.length === 1 ? "source" : "sources"}
                  {repo.branch ? ` on ${repo.branch}` : " on a detached HEAD"}
                </span>
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={(event) => setCommitting({ root: repo.root, opener: event.currentTarget })}
              >
                Commit…
              </Button>
            </div>
          ))}
        </SettingsSection>
      )}
      {editing !== null && (
        <SourceEditor
          environmentId={environmentId}
          overview={overview}
          realPath={editing.realPath}
          title={editing.title}
          opener={editing.opener}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
      {committing !== null && (
        <CommitDialog
          environmentId={environmentId}
          overview={overview}
          pending={commits.find((entry) => entry.repo.root === committing.root)}
          opener={committing.opener}
          home={home}
          onClose={() => setCommitting(null)}
          onCommitted={onSaved}
        />
      )}
    </>
  );
}

type SourceFields = Pick<
  AgentContextSkill,
  "realPath" | "linked" | "bytes" | "repoRoot" | "modified" | "editable" | "readOnlyReason"
>;

function SourceRow({
  title,
  tags,
  warning,
  source,
  focus,
  repo,
  home,
  depth,
  tokens,
  canEdit,
  onEdit,
}: {
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly warning?: string | undefined;
  readonly source: SourceFields;
  /** Scrolls the row into view when it mounts, for links from a thread's Context panel. */
  readonly focus: boolean;
  readonly repo: AgentContextRepo | undefined;
  readonly home: string | null;
  readonly depth: number;
  readonly tokens: string;
  readonly canEdit: boolean;
  readonly onEdit: (opener: HTMLElement) => void;
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
          {warning && (
            <Badge size="sm" variant="warning">
              {warning}
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {source.linked ? "→ " : ""}
          {shortenPath(source.realPath, home)}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {repo === undefined ? (
            <span>not in a git repository</span>
          ) : (
            <>
              <span>{shortenPath(repo.root, home)}</span>
              <Badge size="sm" variant={source.modified ? "warning" : "success"}>
                {source.modified ? "modified" : "clean"}
              </Badge>
            </>
          )}
          <span className="tabular-nums">
            · {formatBytes(source.bytes)} · {tokens}
          </span>
        </p>
        {!source.editable && (
          <p className="text-xs text-muted-foreground">
            Read-only: {source.readOnlyReason ?? "not a source this page edits."}
          </p>
        )}
      </div>
      <Button
        size="xs"
        variant="outline"
        disabled={!source.editable || !canEdit}
        onClick={(event) => onEdit(event.currentTarget)}
      >
        Edit
      </Button>
    </div>
  );
}

function SourceEditor({
  environmentId,
  overview,
  realPath,
  title,
  opener,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly overview: AgentContextOverview;
  readonly realPath: string;
  readonly title: string;
  /** Takes focus back when the dialog closes. */
  readonly opener: HTMLElement;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const input = {
    providerInstanceId: overview.providerInstanceId,
    projectId: overview.projectId,
    realPath,
  };
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
          <DialogTitle>Edit {title}</DialogTitle>
          <DialogDescription className="break-all">Saves to {realPath}</DialogDescription>
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
        ) : (
          <EditorBody
            key={read.data.sha256}
            environmentId={environmentId}
            input={input}
            text={read.data.text}
            sha256={read.data.sha256}
            generated={read.data.generated}
            onReload={() => read.refresh()}
            onClose={onClose}
            onSaved={onSaved}
          />
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
  readonly input: {
    providerInstanceId: ProviderInstanceId;
    projectId: ProjectId;
    realPath: string;
  };
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
          {failure && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {failure.message}
            </p>
          )}
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
  overview,
  pending,
  home,
  opener,
  onClose,
  onCommitted,
}: {
  readonly environmentId: EnvironmentId;
  readonly overview: AgentContextOverview;
  readonly pending: ReturnType<typeof pendingCommits>[number] | undefined;
  readonly home: string | null;
  readonly opener: HTMLElement;
  readonly onClose: () => void;
  readonly onCommitted: () => void;
}) {
  const commit = useAtomCommand(agentContextCommit, { reportFailure: false });
  const canCommit = useAtomValue(agentContextCommit.permissionAtom(environmentId));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg" finalFocus={() => opener}>
        <DialogHeader>
          <DialogTitle>Commit agent context edits</DialogTitle>
          <DialogDescription>
            Commits only these files in{" "}
            {pending ? shortenPath(pending.repo.root, home) : "the repository"}. Other changes stay
            as they are. Undo with git revert.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <ul className="grid gap-0.5 text-xs">
              {pending?.realPaths.map((file) => (
                <li key={file} className="truncate font-mono">
                  {pending ? file.slice(pending.repo.root.length + 1) : file}
                </li>
              ))}
            </ul>
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
            {failure && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {failure}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canCommit || busy || pending === undefined || message.trim() === ""}
            onClick={async () => {
              if (pending === undefined) return;
              setBusy(true);
              setFailure(null);
              const result = await commit({
                environmentId,
                input: {
                  providerInstanceId: overview.providerInstanceId,
                  projectId: overview.projectId,
                  repoRoot: pending.repo.root,
                  realPaths: pending.realPaths,
                  message: message.trim(),
                  expectedHead: pending.repo.head,
                },
              });
              setBusy(false);
              if (result._tag === "Success") {
                onCommitted();
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
    const base = `${watcher.kind}:${watcher.label}:${watcher.pattern}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { ...watcher, id: `${base}:${count}` };
  });
};
const toWatchers = (rows: ReadonlyArray<WatcherRow>): ReadonlyArray<LoadWatcher> =>
  rows.map(({ label, kind, pattern }) => ({ label, kind, pattern }));
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
                pattern: "",
                id: `new:${Date.now()}:${watchers.length}`,
              },
            ])
          }
        >
          <PlusIcon />
          Add pattern
        </Button>
      }
    >
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Tool calls that match a watcher show in a thread's Context panel as knowledge loads, under
        the watcher's label. Command patterns match the shell command; tool patterns match the tool
        name. Both are regular expressions.
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
              aria-label={`Watcher ${index + 1} pattern`}
              aria-invalid={errors[index] !== null}
              className="min-w-48 flex-1"
              font="mono"
              value={watcher.pattern}
              disabled={!canWrite}
              placeholder="Regular expression"
              onChange={(event) => update(watcher.id, { pattern: event.target.value })}
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
                  pattern: watcher.pattern.trim(),
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
  readonly input: { providerInstanceId: ProviderInstanceId; projectId: ProjectId };
  readonly overview: AgentContextOverview | null;
}) {
  const request = {
    threadId: PREVIEW_THREAD_ID,
    providerInstanceId: input.providerInstanceId,
    draft: { projectId: input.projectId, worktreePath: null, interactionMode: "default" as const },
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
