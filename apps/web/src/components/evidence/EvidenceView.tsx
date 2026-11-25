import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MessageId,
  type EnvironmentId,
  type EvidenceChange,
  type EvidenceChangeQa,
  type EvidenceLandingSummary,
  type EvidenceListInput,
  type EvidenceProjectCoverage,
  type ScopedThreadRef,
  type ThreadId,
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
  SendIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { useRef, useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
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
  evidenceCoverage,
  evidenceGet,
  evidenceList,
  evidenceSetQa,
  reloadEvidence,
  useEvidenceEnvironment,
} from "../../state/evidence";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { CheckedLabel, ToolFilterMenuTrigger } from "../ToolFilterMenuTrigger";
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
import {
  captureKind,
  CHECKS,
  checkLabel,
  coverageDraft,
  failedQaDraft,
  leavesNeedsQa,
  QA_STATES,
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
const setEvidenceView = (next: { scope?: "thread" | "all"; needsQa?: boolean }) =>
  useThreadContextSidebarStore.getState().setEvidenceView(next);

export function EvidenceView({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const environmentId = useEvidenceEnvironment(threadRef);
  const storedScope = useThreadContextSidebarStore((state) => state.evidenceScope);
  const needsQa = useThreadContextSidebarStore((state) => state.evidenceNeedsQa);
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
            tooltip={needsQa ? "Showing landings that need QA" : "Showing all landings"}
            active={needsQa}
          />
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Show</MenuGroupLabel>
              <MenuRadioGroup
                value={needsQa ? "needs-qa" : "all"}
                onValueChange={(next) => setEvidenceView({ needsQa: next === "needs-qa" })}
              >
                <MenuRadioItem value="all">
                  <CheckedLabel>All landings</CheckedLabel>
                </MenuRadioItem>
                <MenuRadioItem value="needs-qa">
                  <CheckedLabel>Needs QA</CheckedLabel>
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
          </MenuPopup>
        </Menu>
      </div>
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
          {input.needsQa ? <CheckIcon /> : <ClipboardCheckIcon />}
        </EmptyMedia>
        <EmptyDescription>
          {input.needsQa ? (
            "Nothing waiting for your QA."
          ) : (
            <>
              No landings recorded {input.threadId ? "for this thread " : ""}yet. The lead records
              one with <code>evidence_record</code> after each land.
            </>
          )}
        </EmptyDescription>
        {input.needsQa ? (
          <Button variant="link" size="micro" onClick={() => setEvidenceView({ needsQa: false })}>
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
          Load older landings
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
            {QA_STATES.filter(({ state }) => landing.qa[state] > 0).map(
              ({ state, label, icon: Icon, tone }) => (
                <span key={state} className="inline-flex items-center gap-0.5">
                  <Icon aria-hidden className={cn("size-3", tone)} />
                  <span className="sr-only">{label}</span>
                  {landing.qa[state]}
                </span>
              ),
            )}
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
      {open ? (
        <LandingChanges environmentId={environmentId} landingId={landing.id} needsQa={needsQa} />
      ) : null}
    </section>
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
  const [focusNote, setFocusNote] = useState(false);
  const navigate = useNavigate();
  const [copied, setCopied] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: "commit",
    onCopy: setCopied,
  });
  const long = change.ask.length > 90 || change.ask.includes("\n") || change.summary.length > 0;
  const key = change.ticket?.key ?? change.id;
  const review = reviewDisplay(change.review);
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
          onFocusNote={setFocusNote}
        />
      </div>
      {change.qa.state === "waived" ? (
        <WaivedNote environmentId={environmentId} landingId={landingId} change={change} />
      ) : null}
      {change.qa.state === "failed" ? (
        <FailedNote
          environmentId={environmentId}
          landingId={landingId}
          threadId={threadId}
          change={change}
          autoFocus={focusNote}
        />
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
          <Badge variant={review.variant} className="max-w-full" title={review.label}>
            {review.variant === "success" ? <CheckIcon /> : null}
            <span className="truncate">{review.label}</span>
          </Badge>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<Badge variant={review.variant} className="max-w-full" tabIndex={0} />}
            >
              {review.variant === "success" ? <CheckIcon /> : null}
              <span className="truncate">{review.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{review.hint}</TooltipPopup>
          </Tooltip>
        )}
        {review.threadId !== null ? (
          <Button
            variant="link"
            size="micro"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: review.threadId! },
              })
            }
          >
            <ArrowUpRightIcon />
            Reviewer
          </Button>
        ) : null}
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

function QaMenu({
  environmentId,
  landingId,
  change,
  label,
  leaves,
  onFocusNote,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  change: Change;
  label: string;
  leaves: (next: EvidenceChangeQa["state"]) => boolean;
  onFocusNote: (focus: boolean) => void;
}) {
  const setQa = useSetQa();
  const canSet = useAtomValue(evidenceSetQa.permissionAtom(environmentId));
  const trigger = useRef<HTMLButtonElement>(null);
  const current = QA_STATES.find((entry) => entry.state === change.qa.state)!;
  const choose = async (next: EvidenceChangeQa["state"]) => {
    if (next === change.qa.state) return;
    if (next === "failed") onFocusNote(true);
    if (!(await setQa({ environmentId, input: { landingId, changeId: change.id, state: next } }))) {
      onFocusNote(false);
      return;
    }
    if (leaves(next)) focusAfterCardLeaves(trigger.current);
    reloadEvidence();
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
            const chosen = QA_STATES.find((entry) => entry.state === next);
            if (chosen) void choose(chosen.state);
          }}
        >
          {QA_STATES.map(({ state, label: name, icon: Icon, tone }) => (
            <MenuRadioItem key={state} value={state} closeOnClick>
              <CheckedLabel>
                <span className="flex items-center gap-2">
                  <Icon aria-hidden className={tone} />
                  {state === "failed" ? "Failed…" : name}
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
    reloadEvidence();
  };
  if (!editing)
    return (
      <div className="min-w-0 space-y-0.5 text-muted-foreground">
        {change.qa.note.trim() ? <p className="break-words">QA waived: {change.qa.note}</p> : null}
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
        aria-label={`Why QA was waived for ${key}`}
        placeholder="Why waive QA? (optional)"
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

function FailedNote({
  environmentId,
  landingId,
  threadId,
  change,
  autoFocus,
}: {
  environmentId: EnvironmentId;
  landingId: string;
  threadId: ThreadId;
  change: Change;
  autoFocus: boolean;
}) {
  const [note, setNote] = useState(change.qa.note);
  const [saved, setSaved] = useState(change.qa.note);
  const setQa = useSetQa();
  const navigate = useNavigate();
  const target = scopeThreadRef(environmentId, threadId);
  const thread = useLandingThread(environmentId, threadId);
  const save = async () => {
    if (note === saved) return true;
    setSaved(note);
    const ok = await setQa({
      environmentId,
      input: { landingId, changeId: change.id, state: "failed", note },
    });
    if (!ok) setSaved(saved);
    return ok;
  };
  const send = async () => {
    if (thread.missing) {
      toastManager.add({
        type: "error",
        title: "Can't send the QA note",
        description: "This landing's thread no longer exists.",
      });
      return;
    }
    if (!(await save())) return;
    const store = useComposerDraftStore.getState();
    store.setPrompt(
      target,
      failedQaDraft(store.getComposerDraft(target)?.prompt ?? "", change, note),
    );
    await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
  return (
    <div className="space-y-1.5 rounded-md border border-destructive/30 p-1.5">
      <Textarea
        size="sm"
        aria-label={`What failed in ${change.ticket?.key ?? change.id}`}
        placeholder="What failed?"
        value={note}
        maxLength={2000}
        autoFocus={autoFocus}
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
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  path: string;
  caption: string;
}) {
  const kind = captureKind(path);
  const asset = useAssetUrlState(environmentId, { _tag: "media-file", threadId, path });
  const [broken, setBroken] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
          if (url !== null && kind === "file") window.open(url, "_blank", "noopener,noreferrer");
          else setExpanded(true);
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
      {expanded && url ? (
        <ExpandedImageDialog
          preview={{
            images: [{ src: url, name: caption, ...(kind === "video" ? { type: "video" } : {}) }],
            index: 0,
          }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </figure>
  );
}
