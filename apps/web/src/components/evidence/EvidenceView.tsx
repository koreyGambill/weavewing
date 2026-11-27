import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MessageId,
  type EnvironmentId,
  type EvidenceChange,
  type EvidenceChangeQa,
  type EvidenceSetQaInput,
  type EvidenceLandingSummary,
  type EvidenceListInput,
  type EvidenceProjectCoverage,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { qaNoted } from "@t3tools/client-runtime/qa-card";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ImageIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  ClipboardCheckIcon,
  SendIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { messageRevealNavigation } from "../../lib/assistantCitationNavigation";
import { cn } from "../../lib/utils";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useEnvironmentThread } from "../../state/threads";
import {
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
} from "../../threadRoutes";
import {
  evidenceBulkSetQa,
  evidenceCoverage,
  evidenceGet,
  evidenceList,
  evidenceSetQa,
  useEvidenceEnvironment,
} from "../../state/evidence";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { CheckedLabel, ToolFilterMenuTrigger } from "../ToolFilterMenuTrigger";
import { BulkDismissDialog } from "./BulkDismissDialog";
import { useBulkDismissDraft, useBulkDismissStore } from "./bulkDismissStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyMedia } from "../ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { CaptureTile } from "./CaptureTile";
import {
  CHECKS,
  checkLabel,
  coverageDraft,
  leavesNeedsQa,
  QA_STATES,
  qaTally,
  reviewDisplay,
} from "./evidence.logic";

type Change = EvidenceChange & { readonly qa: EvidenceChangeQa };

/** The landing's thread as the route sees it; the shell list omits idle delegates, so read those directly. */
function useLandingThread(environmentId: EnvironmentId | null, threadId: ThreadId) {
  const shell = useThreadShell(
    environmentId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  const unlisted = environmentId !== null && shell === null;
  const shellStatus = useEnvironmentShellStatus(environmentId);
  const detail = useEnvironmentThread(unlisted ? environmentId : null, unlisted ? threadId : null);
  const state = resolveThreadRouteRenderState({
    bootstrapComplete: isThreadRouteSnapshotAuthoritative(shellStatus),
    serverThreadExists: shell !== null,
    serverThreadDeleted: shell?.deletedAt != null,
    unlistedThreadDetail: detail,
    draftThreadExists: false,
  });
  const title =
    shell?.title ?? Option.getOrNull(Option.map(detail.data, ({ thread }) => thread.title));
  return { missing: state === "missing", title };
}
const setEvidenceView = (next: { scope?: "thread" | "all"; show?: "all" | "needs-qa" | "notes" }) =>
  useThreadContextSidebarStore.getState().setEvidenceView(next);

const SHOW_TOOLTIPS = {
  all: "Showing all landings",
  "needs-qa": "Showing landings that need QA",
  notes: "Showing notes: changes recorded without a QA card",
} as const;

export function EvidenceView({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const environmentId = useEvidenceEnvironment(threadRef);
  const storedScope = useThreadContextSidebarStore((state) => state.evidenceScope);
  const show = useThreadContextSidebarStore((state) => state.evidenceShow);
  const scope = threadRef === null ? "all" : (storedScope ?? "thread");
  const threadProjectId = useThreadShell(threadRef)?.projectId;
  const root = useRef<HTMLDivElement>(null);
  const coverage = useEnvironmentQuery(
    environmentId === null || (scope === "thread" && threadProjectId === undefined)
      ? null
      : evidenceCoverage({
          environmentId,
          input: scope === "thread" ? { projectId: threadProjectId } : {},
        }),
  ).data;
  const dismissed = useThreadContextSidebarStore((state) => state.evidenceCoverageDismissed);
  const coverageKey = (projectId: string) => `${environmentId}:${projectId}`;
  const shown = (coverage ?? []).filter(
    (project) => dismissed[coverageKey(project.projectId)] !== project.head,
  );
  const anyDismissed = shown.length < (coverage?.length ?? 0);
  const canBulkDismiss = useAtomValue(evidenceBulkSetQa.permissionAtom(environmentId));
  const bulkDismissing = useBulkDismissDraft(environmentId) !== null;
  if (environmentId === null) {
    return (
      <Empty size="compact">
        <EmptyDescription>This connection doesn't record evidence.</EmptyDescription>
      </Empty>
    );
  }
  const filter: EvidenceListInput = {
    ...(scope === "thread" && threadRef ? { threadId: threadRef.threadId } : {}),
    ...(show === "needs-qa" ? { needsQa: true } : {}),
    ...(show === "notes" ? { notes: true } : {}),
  };
  return (
    <div ref={root} className="@container/evidence flex min-w-0 flex-col gap-2 text-xs">
      <div className="flex items-center gap-1">
        <ToggleGroup
          aria-label="Evidence scope"
          size="segmented-compact"
          className="min-w-0 flex-1 *:flex-1"
          value={[scope]}
          onValueChange={(value) => {
            if (value[0] === "thread" || value[0] === "all") setEvidenceView({ scope: value[0] });
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
            tooltip={SHOW_TOOLTIPS[show]}
            active={show !== "all"}
          />
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Show</MenuGroupLabel>
              <MenuRadioGroup
                value={show}
                onValueChange={(next) => {
                  if (next === "all" || next === "needs-qa" || next === "notes")
                    setEvidenceView({ show: next });
                }}
              >
                <MenuRadioItem value="all">
                  <CheckedLabel>All landings</CheckedLabel>
                </MenuRadioItem>
                <MenuRadioItem value="needs-qa">
                  <CheckedLabel>Needs QA</CheckedLabel>
                </MenuRadioItem>
                <MenuRadioItem value="notes">
                  <CheckedLabel>Notes</CheckedLabel>
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            {anyDismissed ? <MenuSeparator /> : null}
            {anyDismissed ? (
              <MenuItem
                onClick={() => {
                  const { dismissEvidenceCoverage } = useThreadContextSidebarStore.getState();
                  for (const project of coverage ?? [])
                    dismissEvidenceCoverage(coverageKey(project.projectId), null);
                }}
              >
                Show uncovered merges
              </MenuItem>
            ) : null}
            {canBulkDismiss ? <MenuSeparator /> : null}
            {canBulkDismiss ? (
              <MenuItem onClick={() => useBulkDismissStore.getState().start(environmentId)}>
                Dismiss pending before…
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      {bulkDismissing ? (
        <BulkDismissDialog
          environmentId={environmentId}
          onClose={() => {
            useBulkDismissStore.getState().close();
            root.current?.querySelector<HTMLElement>('[aria-label="Evidence filter"]')?.focus();
          }}
        />
      ) : null}
      {shown.map((project) => (
        <CoverageNotice
          key={project.projectId}
          environmentId={environmentId}
          threadRef={threadProjectId === project.projectId ? threadRef : null}
          coverage={project}
          showProject={scope === "all"}
          onDismiss={() => {
            useThreadContextSidebarStore
              .getState()
              .dismissEvidenceCoverage(coverageKey(project.projectId), project.head);
            root.current?.querySelector<HTMLElement>('[aria-label="Evidence filter"]')?.focus();
          }}
        />
      ))}
      <LandingPage
        key={JSON.stringify(filter)}
        environmentId={environmentId}
        input={filter}
        showThread={scope === "all"}
        first
      />
    </div>
  );
}

function CoverageNotice({
  environmentId,
  threadRef,
  coverage,
  showProject,
  onDismiss,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  coverage: EvidenceProjectCoverage;
  showProject: boolean;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const project = useProject(
    showProject ? scopeProjectRef(environmentId, coverage.projectId) : null,
  );
  const threadId = threadRef?.threadId ?? coverage.leadThreadId;
  const target = useLandingThread(environmentId, threadId);
  const count = coverage.uncoveredCount;
  const listed = coverage.uncovered.slice(0, 3);
  const ask = () => {
    if (target.missing) {
      toastManager.add({ type: "error", title: "The lead's thread no longer exists." });
      return;
    }
    const ref = scopeThreadRef(environmentId, threadId);
    const store = useComposerDraftStore.getState();
    store.setPrompt(ref, coverageDraft(store.getComposerDraft(ref)?.prompt ?? "", coverage));
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
  return (
    <div
      role="status"
      className="min-w-0 space-y-1.5 rounded-md border border-warning/32 bg-warning-surface p-2 text-warning-foreground"
    >
      <div className="flex items-start gap-1.5">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p className="min-w-0 flex-1 break-words">
          <span className="font-medium">
            {count} merge{count === 1 ? "" : "s"}
          </span>{" "}
          on {coverage.branch}
          {project ? ` in ${project.title}` : ""} {count === 1 ? "has" : "have"} no evidence.
        </p>
        <Button
          variant="ghost"
          size="icon-tiny"
          aria-label={`Dismiss until ${coverage.branch} moves`}
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      </div>
      <ul className="space-y-0.5 pl-5">
        {listed.map((merge) => (
          <li key={merge.sha} className="line-clamp-2 break-words">
            <span className="font-mono">{merge.sha.slice(0, 7)}</span> {merge.subject}
          </li>
        ))}
        {count > listed.length ? <li>and {count - listed.length} more</li> : null}
      </ul>
      <div className="pl-5">
        <Button variant="outline" size="micro" onClick={ask}>
          <SendIcon />
          Ask lead
        </Button>
      </div>
    </div>
  );
}

/** One page of landings; "Load older" chains the next page from this page's live cursor. */
function LandingPage({
  environmentId,
  input,
  showThread,
  first,
}: {
  environmentId: EnvironmentId;
  input: EvidenceListInput;
  showThread: boolean;
  first: boolean;
}) {
  const [more, setMore] = useState(false);
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
    return (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          {input.needsQa || input.notes ? <CheckIcon /> : <ClipboardCheckIcon />}
        </EmptyMedia>
        <EmptyDescription>
          {input.needsQa ? (
            "Nothing waiting for your QA."
          ) : input.notes ? (
            `No notes ${input.threadId ? "for this thread" : "yet"}.`
          ) : (
            <>
              No landings recorded {input.threadId ? "for this thread " : ""}yet. The lead records
              one with <code>evidence_record</code> after each land.
            </>
          )}
        </EmptyDescription>
        {input.needsQa || input.notes ? (
          <Button variant="link" size="micro" onClick={() => setEvidenceView({ show: "all" })}>
            Show all landings
          </Button>
        ) : null}
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
          needsQa={input.needsQa === true}
        />
      ))}
      {next === null ? null : more ? (
        <LandingPage
          environmentId={environmentId}
          input={{ ...input, before: next }}
          showThread={showThread}
          first={false}
        />
      ) : (
        <Button variant="ghost" size="micro" onClick={() => setMore(true)}>
          {input.notes ? "Show older" : "Load older landings"}
        </Button>
      )}
    </>
  );
}

function LandingCard({
  environmentId,
  landing,
  showThread,
  needsQa,
}: {
  environmentId: EnvironmentId;
  landing: EvidenceLandingSummary;
  showThread: boolean;
  needsQa: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const thread = useLandingThread(showThread ? environmentId : null, landing.threadId);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <section className="min-w-0 rounded-md border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        data-evidence-card
        className="flex w-full min-w-0 items-start gap-1.5 rounded-md p-2 text-left outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        onClick={() => setOpen(!open)}
      >
        <Chevron aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="line-clamp-2 font-medium text-foreground">{landing.title}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
            <span>{formatDayAwareTimestamp(landing.landedAt, timestampFormat)}</span>
            <span className="font-mono">{landing.target.sha.slice(0, 7)}</span>
            {landing.verifications.map((check, index) => (
              <Badge
                // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a check label.
                key={index}
                className="max-w-full"
                variant={CHECKS[check.result].variant}
                title={checkLabel(check)}
              >
                {check.result === "pass" ? <CheckIcon /> : null}
                <span className="truncate">{checkLabel(check)}</span>
              </Badge>
            ))}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            {qaTally(landing.qa).map(({ key, label, icon: Icon, tone, count }) => (
              <span key={key} className="inline-flex items-center gap-0.5">
                <Icon aria-hidden className={cn("size-3", tone)} />
                <span className="sr-only">{label}</span>
                {count}
              </span>
            ))}
            <span>
              {landing.changeCount} change{landing.changeCount === 1 ? "" : "s"}
            </span>
          </span>
          {showThread ? (
            <span className="block truncate text-muted-foreground">
              in {thread.missing ? "a deleted thread" : (thread.title ?? "another thread")}
            </span>
          ) : null}
        </span>
      </button>
      {landing.notes && !open ? (
        <LandingNotes environmentId={environmentId} landingId={landing.id} notes={landing.notes} />
      ) : null}
      {open ? (
        <LandingChanges environmentId={environmentId} landingId={landing.id} needsQa={needsQa} />
      ) : null}
    </section>
  );
}

/** A landing's notes: each change's title and gaps, and Needs me to raise it as a QA card. */
function LandingNotes({
  environmentId,
  landingId,
  notes,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  notes: NonNullable<EvidenceLandingSummary["notes"]>;
}) {
  const setQa = useSetQa();
  const canSet = useAtomValue(evidenceSetQa.permissionAtom(environmentId));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The server's evidence revision refreshes the list once the note is raised.
  const raise = async (changeId: string, trigger: HTMLElement) => {
    if (!(await setQa({ environmentId, input: { landingId, changeId, state: "pending" } }))) return;
    toastManager.add({ type: "success", title: "Raised as a QA card in its thread." });
    // The raised note leaves the list; focus stays on its landing while other notes remain.
    if (notes.length === 1) focusAfterCardLeaves(trigger);
    else trigger.closest("section")?.querySelector<HTMLElement>("[data-evidence-card]")?.focus();
  };
  return (
    <ul className="min-w-0 space-y-2 border-t border-border p-2">
      {notes.map((note) => {
        const shortened =
          note.captureCount > 0 ||
          note.gapCount > note.gapPreviews.length ||
          [note.title, ...note.gapPreviews].some((text) => text.endsWith("…"));
        const open = expanded.has(note.id);
        return (
          <li key={note.id} className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-start gap-1">
              <span className="min-w-0 flex-1 break-words font-medium">{note.title}</span>
              {shortened ? (
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label={open ? `Show less of ${note.title}` : `Show all of ${note.title}`}
                  aria-expanded={open}
                  onClick={() => {
                    const next = new Set(expanded);
                    if (open) next.delete(note.id);
                    else next.add(note.id);
                    setExpanded(next);
                  }}
                >
                  <ChevronsUpDownIcon />
                </Button>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="micro"
                      className="shrink-0"
                      disabled={!canSet}
                      aria-label={`Needs me: ${note.title}`}
                      onClick={(event) => void raise(note.id, event.currentTarget)}
                    />
                  }
                >
                  Needs me
                </TooltipTrigger>
                <TooltipPopup side="top">Show it as a QA card in its thread</TooltipPopup>
              </Tooltip>
            </div>
            {open ? (
              <NoteDetail
                environmentId={environmentId}
                landingId={landingId}
                changeId={note.id}
                title={note.title}
              />
            ) : (
              <>
                {note.gapPreviews.map((gap, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a gap.
                  <GapLine key={`${index}:${gap}`} gap={gap} />
                ))}
                {note.gapCount > note.gapPreviews.length ? (
                  <p className="pl-4.5 text-muted-foreground">
                    and {note.gapCount - note.gapPreviews.length} more
                  </p>
                ) : null}
                {note.captureCount > 0 ? (
                  <p className="flex items-center gap-1.5 text-muted-foreground">
                    <ImageIcon aria-hidden className="size-3 shrink-0" />
                    {note.captureCount} capture{note.captureCount === 1 ? "" : "s"}
                  </p>
                ) : null}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function GapLine({ gap }: { gap: string }) {
  return (
    <p className="flex items-start gap-1.5 text-muted-foreground">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0 break-words">{gap}</span>
    </p>
  );
}

/** A note's full summary and gaps, read with its landing when the note is expanded. */
function NoteDetail({
  environmentId,
  landingId,
  changeId,
  title,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  changeId: string;
  title: string;
}) {
  const landing = useEnvironmentQuery(evidenceGet({ environmentId, input: { landingId } }));
  const data = landing.data;
  const change = data?.changes.find((candidate) => candidate.id === changeId);
  if (data === null || change === undefined)
    return (
      <p className="text-muted-foreground">
        {landing.error ? `Couldn't load this note: ${landing.error}` : "Loading the note…"}
      </p>
    );
  return (
    <>
      {change.summary.trim() && change.summary.trim() !== title ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{change.summary}</p>
      ) : null}
      {change.gaps.map((gap, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a gap.
        <GapLine key={`${index}:${gap}`} gap={gap} />
      ))}
      {change.captures.length ? (
        <div className="grid grid-cols-2 gap-1.5 @min-[17rem]/evidence:grid-cols-3">
          {change.captures.map((capture, index) => (
            <CaptureTile
              // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a capture path.
              key={`${index}:${capture.path}`}
              environmentId={environmentId}
              threadId={data.threadId}
              path={capture.path}
              caption={capture.caption}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function LandingChanges({
  environmentId,
  landingId,
  needsQa,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  needsQa: boolean;
}) {
  const landing = useEnvironmentQuery(evidenceGet({ environmentId, input: { landingId } }));
  if (landing.data === null) {
    return (
      <div className="flex items-center gap-2 border-t border-border p-2 text-muted-foreground">
        <span className="min-w-0 flex-1">
          {landing.error ? `Couldn't load this landing: ${landing.error}` : "Loading changes…"}
        </span>
        {landing.error ? (
          <Button variant="outline" size="micro" onClick={landing.refresh}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  const { threadId, changes, verifications } = landing.data;
  // Badges truncate a long reason, so the opened landing spells each one out.
  const skipped = verifications.filter((check) => check.result === "skipped" && check.reason);
  return [
    skipped.length > 0 ? (
      <ul key="skipped" className="space-y-0.5 border-t border-border p-2 text-muted-foreground">
        {skipped.map((check, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a check label.
          <li key={index} className="break-words">
            {checkLabel(check)}
          </li>
        ))}
      </ul>
    ) : null,
    ...changes.map((change) => (
      <ChangeRow
        key={change.id}
        environmentId={environmentId}
        landingId={landingId}
        threadId={threadId}
        change={change}
        leaves={(next) => needsQa && leavesNeedsQa(changes, change.id, next)}
      />
    )),
  ];
}

function ChangeRow({
  environmentId,
  landingId,
  threadId,
  change,
  leaves,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  threadId: ThreadId;
  change: Change;
  leaves: (next: EvidenceChangeQa["state"]) => boolean;
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
  const review = reviewDisplay(change.review);
  const link = review.link;
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
          change={change}
          label={key}
          leaves={leaves}
        />
      </div>
      {change.qa.state === "waived" ? (
        <WaivedNote environmentId={environmentId} landingId={landingId} change={change} />
      ) : null}
      {change.qa.state === "problem" && change.qa.note ? (
        <p className="break-words text-warning-foreground">Agent fixing: {change.qa.note}</p>
      ) : null}
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
              void navigate(
                messageRevealNavigation(
                  environmentId,
                  change.askRef!.threadId,
                  MessageId.make(change.askRef!.messageId),
                ),
              )
            }
          >
            <ArrowUpRightIcon />
            Ask
          </Button>
        ) : null}
        {review.hint === null ? (
          <Badge variant="outline" className="max-w-full" title={review.label}>
            <span className="truncate">{review.label}</span>
          </Badge>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<Badge variant="outline" className="max-w-full" tabIndex={0} />}
            >
              <span className="truncate">{review.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{review.hint}</TooltipPopup>
          </Tooltip>
        )}
        {link === null ? null : link.kind === "unavailable" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-description={link.description}
                  className="rounded-sm px-1.5 text-2xs text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              {link.label}
            </TooltipTrigger>
            <TooltipPopup side="top">{link.description}</TooltipPopup>
          </Tooltip>
        ) : (
          <Button
            variant="link"
            size="micro"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: link.threadId },
              })
            }
          >
            <ArrowUpRightIcon />
            {link.label}
          </Button>
        )}
        {change.commits.map((sha, index) => (
          <Button
            // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a commit.
            key={`${index}:${sha}`}
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
      {full && review.hint !== null ? (
        <p className="break-words text-muted-foreground">{review.hint}</p>
      ) : null}
      {full && change.review.reason ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          Review waived: {change.review.reason}
        </p>
      ) : null}
      {full && change.review.summary ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {change.review.summary}
        </p>
      ) : null}
      {change.captures.length ? (
        <div className="grid grid-cols-2 gap-1.5 @min-[17rem]/evidence:grid-cols-3">
          {change.captures.map((capture, index) => (
            <CaptureTile
              // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a capture path.
              key={`${index}:${capture.path}`}
              environmentId={environmentId}
              threadId={threadId}
              path={capture.path}
              caption={capture.caption}
            />
          ))}
        </div>
      ) : null}
      {change.gaps.map((gap, index) => (
        <p
          // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a gap.
          key={`${index}:${gap}`}
          className="flex items-start gap-1.5 rounded-md bg-warning/8 px-2 py-1 text-warning-foreground dark:bg-warning/16"
        >
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{gap}</span>
        </p>
      ))}
    </div>
  );
}

function useSetQa() {
  const setQa = useAtomCommand(evidenceSetQa, { label: "QA state" });
  return async (input: Parameters<typeof setQa>[0]) => (await setQa(input))._tag === "Success";
}

/** The card after this one, else the one before, else the filter: where focus goes when a card leaves. */
function focusAfterCardLeaves(trigger: HTMLElement | null) {
  const card = trigger?.closest("section");
  const header = (sibling: Element | null | undefined) =>
    sibling?.matches("section") ? sibling.querySelector<HTMLElement>("[data-evidence-card]") : null;
  const target =
    header(card?.nextElementSibling) ??
    header(card?.previousElementSibling) ??
    document.querySelector<HTMLElement>('[aria-label="Evidence filter"]');
  target?.focus();
}

const USER_QA_STATES = QA_STATES.filter(
  (entry): entry is Extract<(typeof QA_STATES)[number], { user: true }> => entry.user,
);

function QaMenu({
  environmentId,
  landingId,
  change,
  label,
  leaves,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  change: Change;
  label: string;
  leaves: (next: EvidenceChangeQa["state"]) => boolean;
}) {
  const setQa = useSetQa();
  const canSet = useAtomValue(evidenceSetQa.permissionAtom(environmentId));
  const trigger = useRef<HTMLButtonElement>(null);
  const state = QA_STATES.find((entry) => entry.state === change.qa.state)!;
  const current = qaNoted(change) ? { ...state, label: "Noted" } : state;
  const choose = async (next: EvidenceSetQaInput["state"]) => {
    if (next === change.qa.state) return;
    if (!(await setQa({ environmentId, input: { landingId, changeId: change.id, state: next } })))
      return;
    if (leaves(next)) focusAfterCardLeaves(trigger.current);
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            ref={trigger}
            variant="outline"
            size="micro"
            className="ml-auto shrink-0 justify-between @min-[11rem]/evidence:min-w-23"
            aria-label={`QA for ${label}: ${current.label}`}
            disabled={!canSet}
          />
        }
      >
        <current.icon aria-hidden className={current.tone} />
        <span className="hidden @min-[11rem]/evidence:inline">{current.label}</span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={change.qa.state}
          onValueChange={(next) => {
            const chosen = USER_QA_STATES.find((entry) => entry.state === next);
            if (chosen) void choose(chosen.state);
          }}
        >
          {USER_QA_STATES.map(({ state, label: name, icon: Icon, tone }) => (
            <MenuRadioItem key={state} value={state} closeOnClick>
              <CheckedLabel>
                <span className="flex items-center gap-2">
                  <Icon aria-hidden className={tone} />
                  {name}
                </span>
              </CheckedLabel>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A waived change's optional note: shown when set, and added or edited on demand. */
function WaivedNote({
  environmentId,
  landingId,
  change,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  change: Change;
}) {
  const [editing, setEditing] = useState(false);
  // The editor unmounts with focus in it, so the button that opened it takes focus back.
  const [returnFocus, setReturnFocus] = useState(false);
  const [note, setNote] = useState(change.qa.note);
  const setQa = useSetQa();
  const key = change.ticket?.key ?? change.id;
  const close = () => {
    setEditing(false);
    setReturnFocus(true);
  };
  const save = async () => {
    if (
      note.trim() !== change.qa.note.trim() &&
      !(await setQa({
        environmentId,
        input: { landingId, changeId: change.id, state: "waived", note: note.trim() },
      }))
    )
      return;
    close();
  };
  // The agent's record stays its own; Reopen is how the user changes it.
  if (change.qa.by === "agent")
    return change.qa.note.trim() ? (
      <p className="min-w-0 break-words text-muted-foreground">
        Dismissed by the agent: {change.qa.note}
      </p>
    ) : null;
  if (!editing)
    return (
      <div className="min-w-0 space-y-0.5 text-muted-foreground">
        {change.qa.note.trim() ? <p className="break-words">Dismissed: {change.qa.note}</p> : null}
        <Button
          autoFocus={returnFocus}
          variant="ghost"
          size="micro"
          aria-label={`${change.qa.note.trim() ? "Edit" : "Add"} QA note for ${key}`}
          onClick={() => {
            setNote(change.qa.note);
            setEditing(true);
          }}
        >
          {change.qa.note.trim() ? "Edit note" : "Add note"}
        </Button>
      </div>
    );
  return (
    <form
      className="space-y-1.5 rounded-md border border-border p-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Textarea
        size="sm"
        aria-label={`Why ${key} was dismissed`}
        placeholder="Why dismiss it? (optional)"
        value={note}
        maxLength={2000}
        autoFocus
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex gap-1">
        <Button size="micro" type="submit">
          Save note
        </Button>
        <Button size="micro" variant="ghost" type="button" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
