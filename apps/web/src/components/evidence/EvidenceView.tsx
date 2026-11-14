import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  EvidenceChange,
  EvidenceChangeQa,
  EvidenceLandingSummary,
  EvidenceListInput,
  EvidenceQaState,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  ClipboardCheckIcon,
  FileIcon,
  PlayIcon,
  RefreshCwIcon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { useAssetUrlState } from "../../assets/assetUrls";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import {
  evidenceGet,
  evidenceList,
  evidenceSetQa,
  reloadEvidence,
  useEvidenceCounts,
  useEvidenceEnvironment,
} from "../../state/evidence";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { ToolHeaderButton } from "../threadToolsHost";
import { CheckedLabel, ToolFilterMenuTrigger } from "../ToolFilterMenuTrigger";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyMedia } from "../ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { captureKind, failedQaDraft, QA_STATES } from "./evidence.logic";

type Expand = (preview: ExpandedImagePreview) => void;

export function EvidenceView({
  threadRef,
  actions,
}: {
  threadRef: ScopedThreadRef | null;
  actions: HTMLDivElement | null;
}) {
  const environmentId = useEvidenceEnvironment(threadRef);
  const storedScope = useThreadContextSidebarStore((state) => state.evidenceScope);
  const needsQa = useThreadContextSidebarStore((state) => state.evidenceNeedsQa);
  const counts = useEvidenceCounts(environmentId);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const scope = threadRef === null ? "all" : (storedScope ?? "thread");
  const waiting = (counts.data?.pending ?? 0) + (counts.data?.failed ?? 0);
  const setView = (next: { scope?: "thread" | "all"; needsQa?: boolean }) =>
    useThreadContextSidebarStore.getState().setEvidenceView(next);

  if (environmentId === null) {
    return (
      <Empty size="compact">
        <EmptyDescription>This connection doesn't record evidence.</EmptyDescription>
      </Empty>
    );
  }
  const filter: EvidenceListInput = {
    ...(scope === "thread" && threadRef ? { threadId: threadRef.threadId } : {}),
    ...(needsQa ? { needsQa: true } : {}),
  };
  return (
    <div className="@container/evidence flex min-w-0 flex-col gap-2 text-xs">
      {actions
        ? createPortal(
            <ToolHeaderButton label="Refresh evidence" onClick={reloadEvidence}>
              <RefreshCwIcon />
            </ToolHeaderButton>,
            actions,
          )
        : null}
      <div className="flex items-center gap-1">
        <ToggleGroup
          aria-label="Evidence scope"
          size="segmented-compact"
          className="min-w-0 flex-1 *:flex-1"
          value={[scope]}
          onValueChange={(value) => {
            if (value[0] === "thread" || value[0] === "all") setView({ scope: value[0] });
          }}
        >
          <Toggle value="thread" disabled={threadRef === null}>
            Thread
          </Toggle>
          <Toggle value="all">All</Toggle>
        </ToggleGroup>
        <Menu>
          <ToolFilterMenuTrigger
            label="Evidence filter"
            tooltip={needsQa ? "Showing landings that need QA" : "Showing all landings"}
            active={needsQa}
          />
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Show</MenuGroupLabel>
              <MenuRadioGroup
                value={needsQa ? "needs-qa" : "all"}
                onValueChange={(next) => setView({ needsQa: next === "needs-qa" })}
              >
                <MenuRadioItem value="all">
                  <CheckedLabel>All landings</CheckedLabel>
                </MenuRadioItem>
                <MenuRadioItem value="needs-qa">
                  <CheckedLabel>Needs QA</CheckedLabel>
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <span className="min-w-6 shrink-0 text-right text-muted-foreground tabular-nums">
          {waiting}
          <span className="sr-only @min-[15rem]/evidence:not-sr-only"> to QA</span>
        </span>
      </div>
      <LandingPages
        key={JSON.stringify(filter)}
        environmentId={environmentId}
        input={filter}
        showThread={scope === "all"}
        onExpand={setPreview}
      />
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

function LandingPages(props: {
  environmentId: EnvironmentId;
  input: EvidenceListInput;
  showThread: boolean;
  onExpand: Expand;
}) {
  const [cursors, setCursors] = useState<ReadonlyArray<EvidenceListInput["before"]>>([undefined]);
  return cursors.map((before, index) => (
    <LandingPage
      key={before ? `${before.landedAt}:${before.id}` : "first"}
      {...props}
      input={{ ...props.input, ...(before ? { before } : {}) }}
      first={index === 0}
      onMore={index === cursors.length - 1 ? (next) => setCursors([...cursors, next]) : undefined}
    />
  ));
}

function LandingPage({
  environmentId,
  input,
  showThread,
  onExpand,
  first,
  onMore,
}: {
  environmentId: EnvironmentId;
  input: EvidenceListInput;
  showThread: boolean;
  onExpand: Expand;
  first: boolean;
  onMore: ((next: NonNullable<EvidenceListInput["before"]>) => void) | undefined;
}) {
  const page = useEnvironmentQuery(evidenceList({ environmentId, input }));
  if (page.data === null) {
    return page.error ? (
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="min-w-0 flex-1">Couldn't load evidence: {page.error}</span>
        <Button variant="outline" size="micro" onClick={page.refresh}>
          Retry
        </Button>
      </div>
    ) : (
      <p className="text-muted-foreground">Loading evidence…</p>
    );
  }
  if (first && page.data.items.length === 0) {
    return input.needsQa ? (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <CheckIcon />
        </EmptyMedia>
        <EmptyDescription>Nothing waiting for your QA.</EmptyDescription>
        <Button
          variant="link"
          size="micro"
          onClick={() =>
            useThreadContextSidebarStore.getState().setEvidenceView({ needsQa: false })
          }
        >
          Show all landings
        </Button>
      </Empty>
    ) : (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <ClipboardCheckIcon />
        </EmptyMedia>
        <EmptyDescription>
          No landings recorded {input.threadId ? "for this thread " : ""}yet. The lead records one
          with <code>evidence_record</code> after each land.
        </EmptyDescription>
      </Empty>
    );
  }
  const next = page.data.next;
  return (
    <>
      {page.data.items.map((landing) => (
        <LandingCard
          key={landing.id}
          environmentId={environmentId}
          landing={landing}
          showThread={showThread}
          onExpand={onExpand}
        />
      ))}
      {next && onMore ? (
        <Button variant="ghost" size="micro" onClick={() => onMore(next)}>
          Load older landings
        </Button>
      ) : null}
    </>
  );
}

function LandingCard({
  environmentId,
  landing,
  showThread,
  onExpand,
}: {
  environmentId: EnvironmentId;
  landing: EvidenceLandingSummary;
  showThread: boolean;
  onExpand: Expand;
}) {
  const [open, setOpen] = useState(false);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const thread = useThreadShell(
    showThread ? scopeThreadRef(environmentId, landing.threadId) : null,
  );
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <section className="min-w-0 rounded-md border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 items-start gap-1.5 rounded-md p-2 text-left outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        onClick={() => setOpen(!open)}
      >
        <Chevron aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="line-clamp-2 font-medium text-foreground">{landing.title}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
            <span>{formatDayAwareTimestamp(landing.landedAt, timestampFormat)}</span>
            <span className="font-mono">{landing.target.sha.slice(0, 7)}</span>
            {landing.verifications.map((check) => (
              <Badge
                key={`${check.label}:${check.result}`}
                className="max-w-full"
                variant={
                  check.result === "pass"
                    ? "success"
                    : check.result === "fail"
                      ? "error"
                      : "outline"
                }
              >
                {check.result === "pass" ? <CheckIcon /> : null}
                <span className="truncate">
                  {check.label}
                  {check.result === "skipped" ? " skipped" : null}
                </span>
              </Badge>
            ))}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            {QA_STATES.filter(({ state }) => landing.qa[state] > 0).map(({ state, label, dot }) => (
              <span key={state} className="inline-flex items-center gap-1">
                <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
                <span className="sr-only">{label}</span>
                {landing.qa[state]}
              </span>
            ))}
            <span>
              {landing.changeCount} change{landing.changeCount === 1 ? "" : "s"}
            </span>
          </span>
          {showThread ? (
            <span className="block truncate text-muted-foreground">
              in {thread?.title ?? "another thread"}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <LandingChanges environmentId={environmentId} landingId={landing.id} onExpand={onExpand} />
      ) : null}
    </section>
  );
}

function LandingChanges({
  environmentId,
  landingId,
  onExpand,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  onExpand: Expand;
}) {
  const landing = useEnvironmentQuery(evidenceGet({ environmentId, input: { landingId } }));
  if (landing.data === null) {
    return (
      <p className="border-t border-border p-2 text-muted-foreground">
        {landing.error ? `Couldn't load this landing: ${landing.error}` : "Loading changes…"}
      </p>
    );
  }
  const threadId = landing.data.threadId;
  return landing.data.changes.map((change) => (
    <ChangeRow
      key={change.id}
      environmentId={environmentId}
      landingId={landingId}
      threadId={threadId}
      change={change}
      onExpand={onExpand}
    />
  ));
}

function ChangeRow({
  environmentId,
  landingId,
  threadId,
  change,
  onExpand,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  threadId: ThreadId;
  change: EvidenceChange & { readonly qa: EvidenceChangeQa };
  onExpand: Expand;
}) {
  const [full, setFull] = useState(false);
  const navigate = useNavigate();
  const [copied, setCopied] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: "commit",
    onCopy: setCopied,
  });
  const long = change.ask.length > 90 || change.ask.includes("\n") || change.summary.length > 0;
  const key = change.ticket?.key ?? change.id;
  const verdict = change.review.verdict;
  return (
    <div className="min-w-0 space-y-1.5 border-t border-border p-2">
      <div className="flex items-center gap-1">
        <span className="min-w-0 truncate font-medium">{key}</span>
        {long ? (
          <Button
            variant="ghost"
            size="icon-tiny"
            aria-label={full ? `Show less of ${key}` : `Show all of ${key}`}
            aria-expanded={full}
            onClick={() => setFull(!full)}
          >
            <ChevronsUpDownIcon />
          </Button>
        ) : null}
        <QaMenu
          environmentId={environmentId}
          landingId={landingId}
          changeId={change.id}
          label={key}
          state={change.qa.state}
        />
      </div>
      <p className={cn("whitespace-pre-wrap break-words", !full && "line-clamp-2")}>
        “{change.ask}”
      </p>
      {full && change.summary ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{change.summary}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        {change.askRef ? (
          <Button
            variant="link"
            size="micro"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: change.askRef!.threadId },
              })
            }
          >
            <ArrowUpRightIcon />
            Ask
          </Button>
        ) : null}
        <Badge
          variant={
            verdict === "approved" ? "success" : verdict === "waived" ? "outline" : "warning"
          }
        >
          {verdict === "approved" ? <CheckIcon /> : null}
          {verdict === "changes_requested"
            ? "changes requested"
            : verdict === "waived"
              ? "review waived"
              : "approved"}
          {change.review.by ? ` · ${change.review.by}` : null}
        </Badge>
        {change.commits.map((sha) => (
          <Button
            key={sha}
            variant="ghost"
            size="micro"
            aria-label={`Copy commit ${sha}`}
            onClick={() => copyToClipboard(sha, sha)}
          >
            {isCopied && copied === sha ? <CheckIcon /> : null}
            <span className="font-mono">{sha.slice(0, 7)}</span>
          </Button>
        ))}
      </div>
      {full && change.review.summary ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {change.review.summary}
        </p>
      ) : null}
      {change.captures.length ? (
        <div className="grid grid-cols-2 gap-1.5 @min-[17rem]/evidence:grid-cols-3">
          {change.captures.map((capture) => (
            <CaptureTile
              key={capture.path}
              environmentId={environmentId}
              threadId={threadId}
              path={capture.path}
              caption={capture.caption}
              onExpand={onExpand}
            />
          ))}
        </div>
      ) : null}
      {change.gaps.map((gap) => (
        <p
          key={gap}
          className="flex items-start gap-1.5 rounded-md bg-warning/8 px-2 py-1 text-warning-foreground dark:bg-warning/16"
        >
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{gap}</span>
        </p>
      ))}
      {change.qa.state === "failed" ? (
        <FailedNote
          environmentId={environmentId}
          landingId={landingId}
          threadId={threadId}
          change={change}
        />
      ) : null}
    </div>
  );
}

function useSetQa() {
  const setQa = useAtomCommand(evidenceSetQa, { label: "QA state" });
  return async (input: Parameters<typeof setQa>[0]) => {
    const result = await setQa(input);
    if (result._tag === "Success") reloadEvidence();
    return result._tag === "Success";
  };
}

function QaMenu({
  environmentId,
  landingId,
  changeId,
  label,
  state,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  changeId: string;
  label: string;
  state: EvidenceQaState;
}) {
  const setQa = useSetQa();
  const canSet = useAtomValue(evidenceSetQa.permissionAtom(environmentId));
  const current = QA_STATES.find((entry) => entry.state === state)!;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="outline"
            size="micro"
            className="ml-auto shrink-0 justify-between @min-[15rem]/evidence:min-w-23"
            aria-label={`QA for ${label}: ${current.label}`}
            disabled={!canSet}
          />
        }
      >
        <span aria-hidden className={cn("size-2 rounded-full", current.dot)} />
        <span className="hidden @min-[15rem]/evidence:inline">{current.label}</span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={state}
          onValueChange={(next) => {
            const chosen = QA_STATES.find((entry) => entry.state === next);
            if (chosen && chosen.state !== state)
              void setQa({
                environmentId,
                input: { landingId, changeId, state: chosen.state },
              });
          }}
        >
          {QA_STATES.map((entry) => (
            <MenuRadioItem key={entry.state} value={entry.state} closeOnClick>
              <CheckedLabel>
                <span className="flex items-center gap-2">
                  <span aria-hidden className={cn("size-2 rounded-full", entry.dot)} />
                  {entry.state === "failed" ? "Failed…" : entry.label}
                </span>
              </CheckedLabel>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function FailedNote({
  environmentId,
  landingId,
  threadId,
  change,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  threadId: ThreadId;
  change: EvidenceChange & { readonly qa: EvidenceChangeQa };
}) {
  const [note, setNote] = useState(change.qa.note);
  const setQa = useSetQa();
  const navigate = useNavigate();
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const save = () =>
    note === change.qa.note
      ? Promise.resolve(true)
      : setQa({
          environmentId,
          input: { landingId, changeId: change.id, state: "failed", note },
        });
  const send = async () => {
    if (!(await save())) return;
    const target = scopeThreadRef(environmentId, threadId);
    const store = useComposerDraftStore.getState();
    store.setPrompt(
      target,
      failedQaDraft(store.getComposerDraft(target)?.prompt ?? "", change, note),
    );
    await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    toastManager.add({
      type: "info",
      title: "QA note drafted",
      description: `Added to the composer in ${thread?.title ?? "the landing's thread"}. Read it, then send.`,
    });
  };
  return (
    <div className="space-y-1.5 rounded-md border border-destructive/30 p-1.5">
      <Textarea
        size="sm"
        aria-label={`What failed in ${change.ticket?.key ?? change.id}`}
        placeholder="What failed?"
        value={note}
        maxLength={2000}
        onChange={(event) => setNote(event.target.value)}
        onBlur={() => void save()}
      />
      <Button size="micro" onClick={() => void send()}>
        <SendIcon />
        Send to thread
      </Button>
    </div>
  );
}

function CaptureTile({
  environmentId,
  threadId,
  path,
  caption,
  onExpand,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  path: string;
  caption: string;
  onExpand: Expand;
}) {
  const kind = captureKind(path);
  const asset = useAssetUrlState(environmentId, { _tag: "media-file", threadId, path });
  const [broken, setBroken] = useState(false);
  const url = asset._tag === "Success" ? asset.url : null;
  const missing = broken || asset._tag === "Failure";
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return (
    <figure className="min-w-0 space-y-0.5">
      <button
        type="button"
        aria-label={`Open capture: ${caption}`}
        disabled={url === null || missing}
        className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 text-muted-foreground outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset disabled:cursor-default"
        onClick={() => {
          if (url === null) return;
          if (kind === "file") window.open(url, "_blank", "noopener,noreferrer");
          else
            onExpand({
              images: [{ src: url, name: caption, ...(kind === "video" ? { type: "video" } : {}) }],
              index: 0,
            });
        }}
      >
        {missing ? (
          <span className="min-w-0 px-1 text-center text-2xs">
            Missing
            <span className="block truncate">{name}</span>
          </span>
        ) : kind === "image" && url ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover object-top"
            onError={() => setBroken(true)}
          />
        ) : kind === "video" ? (
          <PlayIcon aria-hidden className="size-4" />
        ) : kind === "file" ? (
          <FileIcon aria-hidden className="size-4" />
        ) : null}
      </button>
      <figcaption className="truncate text-2xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
