import { useNavigate } from "@tanstack/react-router";
import { qaCardTitle, qaPresence } from "@t3tools/client-runtime/qa-card";
import type { EvidenceLanding, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { use } from "react";

import { useThreadEvidence } from "../../state/evidence";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { Button } from "../ui/button";
import { ThreadEvidenceContext } from "./ThreadEvidenceContext";
import { ThreadQaCard } from "./ThreadQaCard";

const landedOn = (landing: EvidenceLanding) =>
  `Landed on ${landing.target.branch} · ${landing.target.sha.slice(0, 7)}`;

function MutedLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex min-w-0 items-start gap-1.5 px-1 text-xs break-words text-muted-foreground">
      <CheckIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A placed landing outside this thread's read: shown in Evidence, where every landing lists. */
function OpenInEvidenceLine({ landingId }: { landingId: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 px-1 text-xs text-muted-foreground">
      <CheckIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 break-words">Landing {landingId}</span>
      <Button
        variant="link"
        size="micro"
        onClick={() => useThreadContextSidebarStore.getState().show("evidence")}
      >
        <ArrowUpRightIcon />
        Open in Evidence
      </Button>
    </div>
  );
}

/** A landing a delegated child recorded, seen in the child's own thread: its QA is the lead's. */
function LeadQaPointer({
  threadRef,
  landing,
}: {
  threadRef: ScopedThreadRef;
  landing: EvidenceLanding;
}) {
  const navigate = useNavigate();
  const qaThreadId = landing.qaThreadId;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 px-1 text-xs text-muted-foreground">
      <CheckIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 break-words">
        {landedOn(landing)} · its QA is in the lead's thread
      </span>
      {qaThreadId === undefined ? null : (
        <Button
          variant="link"
          size="micro"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: threadRef.environmentId, threadId: qaThreadId },
            })
          }
        >
          <ArrowUpRightIcon />
          Open lead thread
        </Button>
      )}
    </div>
  );
}

/**
 * The QA cards for landings placed at one spot in the timeline: an `evidence_record` call, or the
 * completion of a delegated child that recorded one. Changes with nothing to check get one line.
 */
export function ThreadEvidenceTimelineRow({
  threadRef,
  landingIds,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly landingIds: ReadonlyArray<string>;
}) {
  // The thread's timeline reads its landings once for every row; a timeline shown elsewhere reads here.
  const shared = use(ThreadEvidenceContext);
  const own = useThreadEvidence(shared === null ? threadRef : null, landingIds);
  const { data, error, supported, requested } = shared ?? own;
  return (
    <div className="flex min-w-0 flex-col gap-2 px-1 py-0.5">
      {landingIds.map((landingId) => {
        const landing = data?.landings.find((candidate) => candidate.id === landingId);
        if (landing === undefined) {
          if (!supported) return null;
          // A landing the read did not ask for may still exist, so it gets a way in, not a verdict.
          if (data !== null && !requested.has(landingId))
            return <OpenInEvidenceLine key={landingId} landingId={landingId} />;
          return (
            <p
              key={landingId}
              role="status"
              className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
            >
              {data === null
                ? (error ?? "Loading QA…")
                : `Landing ${landingId} is no longer available.`}
            </p>
          );
        }
        if ((landing.qaThreadId ?? landing.threadId) !== threadRef.threadId)
          return <LeadQaPointer key={landingId} threadRef={threadRef} landing={landing} />;
        const shown = landing.changes.filter((change) => qaPresence(change.qa) !== "none");
        if (shown.length === 0)
          return (
            <MutedLine key={landingId}>
              {landedOn(landing)} · {landing.title}
            </MutedLine>
          );
        return shown.map((change) =>
          qaPresence(change.qa) === "quiet" ? (
            <MutedLine key={`${landingId}/${change.id}`}>
              {landedOn(landing)} · {qaCardTitle(change)} · nothing to check
            </MutedLine>
          ) : (
            <ThreadQaCard
              key={`${landingId}/${change.id}`}
              threadRef={threadRef}
              landing={landing}
              change={change}
            />
          ),
        );
      })}
    </div>
  );
}
