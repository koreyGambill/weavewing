import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  qaCardLead,
  qaCardOutcome,
  qaCardStatus,
  qaCardTitle,
  qaKey,
  qaRef,
  type QaCardStatus,
  type QaChange,
} from "@t3tools/client-runtime/qa-card";
import { qaPointers } from "@t3tools/client-runtime/state/waiting-item-references";
import type { EvidenceChangeQa, EvidenceLanding, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { evidenceSetQa } from "../../state/evidence";
import { useAtomCommand } from "../../state/use-atom-command";
import { CardStatusBadge, type CardBadgeVariant } from "../questions/QuestionStatusBadge";
import {
  CardReasonForm,
  HelpButton,
  NextReferenceButton,
  ThreadCard,
  ThreadCardClosedLine,
  ThreadCardHeading,
} from "../questions/ThreadCardShell";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CaptureTile } from "./CaptureTile";
import { CHECKS, checkLabel, reviewDisplay } from "./evidence.logic";
import { qaDiscussRecord } from "./qaComposer";
import {
  removeWaitingItemDiscuss,
  toggleWaitingItemDiscuss,
  useWaitingItemsInComposer,
} from "../waiting/waitingItemComposer";

const HELP = {
  dismiss: "Close this without checking it. Nothing is sent to the agent; you can add why later.",
  discuss: "Put a reference to this change in the composer and write about it there.",
  discussOff: "Take the reference to this change out of the composer.",
  looksGood: "You checked it and it works. Nothing is sent to the agent.",
  reopen: "Open this again so you can check it. Nothing is sent to the agent.",
  reason: "Say why you dismissed it. The agent reads it with the landing.",
};

const STATUS: Record<
  QaCardStatus,
  { readonly label: string; readonly variant: CardBadgeVariant; readonly help: string }
> = {
  open: {
    label: "Open",
    variant: "outline",
    help: "Waiting on you. Check the change, then choose Looks good, Discuss or Dismiss.",
  },
  "in-composer": {
    label: "In composer",
    variant: "info-outline",
    help: "A reference to this change is in your composer. It goes with your next message.",
  },
  discussing: {
    label: "Discussing",
    variant: "warning-outline",
    help: "You sent a message about this change. The agent records what it settled; you can still answer here.",
  },
  "confirmed-by-you": {
    label: "Confirmed by you",
    variant: "success-outline",
    help: "You checked it and it works.",
  },
  recorded: {
    label: "Recorded by the agent",
    variant: "success-outline",
    help: "The agent recorded this from your message. Reopen it if the agent misread you.",
  },
  "agent-fixing": {
    label: "Agent fixing",
    variant: "warning-outline",
    help: "The agent recorded a problem from your message and owes a fix.",
  },
  dismissed: {
    label: "Dismissed",
    variant: "outline",
    help: "Closed without checking.",
  },
};

/** The badge for a QA card, with the agent's or user's note as its meaning when there is one. */
export function QaStatusBadge({ status, note }: { status: QaCardStatus; note: string }) {
  const { label, variant, help } = STATUS[status];
  const noted =
    note && (status === "recorded" || status === "agent-fixing" || status === "dismissed");
  return <CardStatusBadge label={label} variant={variant} help={noted ? note : help} />;
}

/** One read-only row: a muted label column, then the content, with the option rows' padding. */
function QaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-sm @min-[28rem]:flex-row @min-[28rem]:gap-2">
      <span className="w-18 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * One landed change waiting on the user's QA, or settled: the question card's shell with the
 * change's review, checks, captures and gaps, and Dismiss, Discuss and Looks good.
 */
export function ThreadQaCard({
  threadRef,
  landing,
  change,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly landing: EvidenceLanding;
  readonly change: QaChange;
}) {
  const environmentId = threadRef.environmentId;
  const canAct = useAtomValue(evidenceSetQa.permissionAtom(environmentId));
  const setQa = useAtomCommand(evidenceSetQa, { label: "QA" });
  const navigate = useNavigate();
  const inComposer = useWaitingItemsInComposer(threadRef, "qa").has(qaKey(landing.id, change.id));
  // The server's answer shows at once; the thread's next read replaces it.
  const [answered, setAnswered] = useState<EvidenceChangeQa | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  // Where focus goes once the card changes shape under the button that was pressed.
  const focusNext = useRef<"line" | "card" | "reason" | null>(null);
  const qa = answered !== null && answered.updatedAt > change.qa.updatedAt ? answered : change.qa;
  const status = qaCardStatus(qa, inComposer);
  const waiting = qa.state === "pending" || qa.state === "quiet";
  const usable = canAct && !busy;
  const ref = qaRef(change);
  const title = qaCardTitle(change);
  const label = `${ref}: ${title}`;
  const outcome = qaCardOutcome(qa);

  const answer = async (state: "pending" | "confirmed" | "waived", note?: string) => {
    setBusy(true);
    const result = await setQa({
      environmentId,
      input: {
        landingId: landing.id,
        changeId: change.id,
        state,
        ...(note === undefined ? {} : { note }),
      },
    });
    setBusy(false);
    if (result._tag !== "Success") return false;
    setAnswered(result.value);
    return true;
  };
  const settle = async (state: "confirmed" | "waived") => {
    focusNext.current = "line";
    // Only once the server took it: a refused write leaves the change open with its chip.
    if (await answer(state))
      removeWaitingItemDiscuss(threadRef, "qa", qaKey(landing.id, change.id));
    else focusNext.current = null;
    setExpanded(false);
  };
  const reopen = async () => {
    focusNext.current = "card";
    setExpanded(false);
    if (!(await answer("pending"))) focusNext.current = null;
  };
  // The reason form replaces the button that opened it, so closing it hands focus back there.
  const closeReason = () => {
    focusNext.current = "reason";
    setReason(null);
  };
  const saveReason = async () => {
    if (reason === null) return;
    if (reason.trim() !== qa.note.trim() && !(await answer("waived", reason.trim()))) return;
    closeReason();
  };
  const focusOnMount = (target: "line" | "card" | "reason") => (node: HTMLButtonElement | null) => {
    if (node === null || focusNext.current !== target) return;
    focusNext.current = null;
    node.focus();
  };

  const reopenButton = (
    <HelpButton
      help={HELP.reopen}
      aria-label={`Reopen ${ref}`}
      disabled={!usable}
      onClick={() => void reopen()}
    >
      Reopen
    </HelpButton>
  );
  const nextReference = (
    <NextReferenceButton
      item={{ kind: "qa", landingId: landing.id, changeId: change.id }}
      refLabel={ref}
      pointers={qaPointers(qa)}
    />
  );
  const note = qa.note.trim();
  const userDismissed = qa.state === "waived" && qa.by !== "agent";

  if (!waiting && !expanded) {
    return (
      <ThreadCardClosedLine
        id={undefined}
        label={label}
        refLabel={ref}
        title={title}
        outcome={outcome}
        hint={note ? <p className="whitespace-pre-wrap">{note}</p> : undefined}
        detail={
          qa.state === "problem" && note ? (
            <QaRow label="Problem">
              <span className="whitespace-pre-wrap break-words">{note}</span>
            </QaRow>
          ) : undefined
        }
        expandRef={focusOnMount("line")}
        onExpand={() => setExpanded(true)}
        stackOnNarrow
      >
        <QaStatusBadge status={status} note={note} />
        {nextReference}
        {reopenButton}
      </ThreadCardClosedLine>
    );
  }

  const review = reviewDisplay(change.review);
  const link = review.link;
  const lead = qaCardLead(change);
  const ownNote = note
    ? qa.state === "problem"
      ? "Problem"
      : qa.by === "agent"
        ? "Agent's note"
        : "Reason"
    : null;

  return (
    <ThreadCard
      id={undefined}
      label={label}
      waiting={waiting}
      heading={<ThreadCardHeading refLabel={ref} title={title} editable={waiting} />}
      onCollapse={waiting ? undefined : () => setExpanded(false)}
      controls={
        <>
          <QaStatusBadge status={status} note={note} />
          {nextReference}
        </>
      }
    >
      <div className="space-y-0.5">
        {lead.kind === "check" ? (
          lead.rows.map(({ label, text }) => (
            <QaRow key={label} label={label}>
              <span className="break-words">{text}</span>
            </QaRow>
          ))
        ) : (
          <p className="px-1.5 text-sm text-muted-foreground">{lead.text}</p>
        )}
        {ownNote ? (
          <QaRow label={ownNote}>
            <span className="whitespace-pre-wrap break-words">{note}</span>
          </QaRow>
        ) : null}
      </div>
      {reason !== null ? (
        <CardReasonForm
          label={`Why ${ref} was dismissed`}
          value={reason}
          maxLength={2000}
          disabled={!usable}
          onChange={setReason}
          onCancel={closeReason}
          onSave={() => void saveReason()}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {waiting ? (
            <>
              <HelpButton
                help={HELP.dismiss}
                aria-label={`Dismiss ${ref}`}
                disabled={!usable}
                onClick={() => void settle("waived")}
              >
                Dismiss
              </HelpButton>
              <HelpButton
                help={inComposer ? HELP.discussOff : HELP.discuss}
                aria-label={`Discuss ${ref}`}
                aria-pressed={inComposer}
                disabled={!canAct}
                onClick={(event) =>
                  toggleWaitingItemDiscuss(
                    threadRef,
                    qaDiscussRecord(landing, change),
                    event.currentTarget,
                  )
                }
              >
                Discuss
              </HelpButton>
              <HelpButton
                help={HELP.looksGood}
                aria-label={`Looks good: ${ref}`}
                // A disabled primary button still reads as live, so it is primary only when usable.
                variant={usable ? "default" : "contrast-outline"}
                ref={focusOnMount("card")}
                disabled={!usable}
                onClick={() => void settle("confirmed")}
              >
                Looks good
              </HelpButton>
            </>
          ) : (
            <>
              {userDismissed ? (
                <HelpButton
                  help={HELP.reason}
                  aria-label={`${note ? "Edit" : "Add"} why ${ref} was dismissed`}
                  ref={focusOnMount("reason")}
                  disabled={!usable}
                  onClick={() => setReason(qa.note)}
                >
                  {note ? "Edit reason" : "Add reason"}
                </HelpButton>
              ) : null}
              {reopenButton}
            </>
          )}
        </div>
      )}
      <Collapsible>
        <CollapsibleTrigger className="group" render={<Button variant="ghost" size="sm" />}>
          <ChevronRightIcon aria-hidden className="group-data-panel-open:rotate-90" />
          Evidence
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <p className="px-1.5 text-xs break-words text-muted-foreground">
            Landed on {landing.target.branch} · {landing.target.sha.slice(0, 7)}
          </p>
          <div className="space-y-0.5">
            <QaRow label="Ask">
              <span className="whitespace-pre-wrap break-words">{change.ask}</span>
            </QaRow>
            <QaRow label="Summary">
              <span className="whitespace-pre-wrap break-words">{change.summary}</span>
            </QaRow>
            <QaRow label="Review">
              <span className="flex flex-wrap items-center gap-1">
                {review.hint === null ? (
                  <span className="break-words">{review.label}</span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          className="rounded-sm break-words outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        />
                      }
                    >
                      {review.label}
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-72">
                      {review.hint}
                    </TooltipPopup>
                  </Tooltip>
                )}
                {link === null ? null : link.kind === "unavailable" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          aria-description={link.description}
                          className="rounded-sm text-xs text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
              </span>
            </QaRow>
            {landing.verifications.length > 0 ? (
              <QaRow label="Checks">
                <span className="flex flex-wrap gap-1">
                  {landing.verifications.map((check, index) => (
                    <Tooltip
                      // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a check label.
                      key={index}
                    >
                      <TooltipTrigger
                        render={
                          <Badge
                            size="sm"
                            variant={CHECKS[check.result].variant}
                            className="max-w-full"
                            tabIndex={0}
                          />
                        }
                      >
                        <span className="truncate">{checkLabel(check)}</span>
                      </TooltipTrigger>
                      <TooltipPopup side="top" className="max-w-72">
                        {checkLabel(check)}
                      </TooltipPopup>
                    </Tooltip>
                  ))}
                </span>
              </QaRow>
            ) : null}
            {change.captures.length > 0 ? (
              <QaRow label="Captures">
                <div className="grid grid-cols-1 gap-1.5 @min-[28rem]:grid-cols-[repeat(auto-fill,11.25rem)]">
                  {change.captures.map((capture, index) => (
                    <CaptureTile
                      // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a capture path.
                      key={`${index}:${capture.path}`}
                      environmentId={environmentId}
                      threadId={landing.threadId}
                      path={capture.path}
                      caption={capture.caption}
                    />
                  ))}
                </div>
              </QaRow>
            ) : null}
            {change.gaps.map((gap, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a gap.
              <QaRow key={`${index}:${gap}`} label="Gap">
                <span className="break-words">{gap}</span>
              </QaRow>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </ThreadCard>
  );
}
