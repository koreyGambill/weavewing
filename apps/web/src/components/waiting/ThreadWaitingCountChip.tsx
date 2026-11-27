import {
  type TrackedAnswerWaitingRow,
  type WaitingCounts,
  type WaitingItemSummary,
} from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WAITING_KIND_HEADING,
  groupWaitingItems,
  waitingChipLabel,
  waitingStripSummary,
  waitingTotalWithAnswers,
} from "./waitingStrip.logic";

// Everything listed but not counted says why.
const stateNote = (item: WaitingItemSummary) =>
  item.sent === true ? "answer queued" : STATE_NOTE[item.state];
const STATE_NOTE: Partial<Record<WaitingItemSummary["state"], string>> = {
  deferred: "deferred",
  discussing: "discussing",
  problem: "agent fixing",
};

/**
 * A row's count of items waiting on the user. Hovering lists the thread's waiting items by kind
 * from the row's own data, so a hover reads nothing from the server.
 */
export function ThreadWaitingCountChip({
  counts,
  waiting,
  answers,
}: {
  readonly counts: WaitingCounts;
  readonly waiting: ReadonlyArray<WaitingItemSummary> | undefined;
  readonly answers?: ReadonlyArray<TrackedAnswerWaitingRow> | undefined;
}) {
  const total = waitingTotalWithAnswers(counts);
  const label = waitingChipLabel(counts);
  const groups = groupWaitingItems(waiting);
  // The row carries a capped list, so a long backlog ends with how many it left out.
  const unlisted = waitingStripSummary(waiting, counts, answers?.length)?.unlisted ?? 0;
  const answered = (answers ?? []).filter((row) => row.state === "answered");
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="info" size="sm" aria-label={label} />}>
        {total}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        <p className="font-medium">{label}</p>
        {groups.map((group) => (
          <section key={group.kind} className="mt-1.5">
            <h4 className="text-muted-foreground">{WAITING_KIND_HEADING[group.kind]}</h4>
            <ul className="mt-0.5 space-y-0.5">
              {group.items.map((item) => (
                <li key={item.key} className="flex min-w-0 gap-1.5">
                  <span className="shrink-0 font-medium tabular-nums">{item.ref}</span>
                  <span className="min-w-0 break-words">
                    {item.title}
                    {stateNote(item) ? (
                      <span className="text-muted-foreground"> ({stateNote(item)})</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {answered.length > 0 ? (
          <section className="mt-1.5">
            <h4 className="text-muted-foreground">Answers</h4>
            <ul className="mt-0.5 space-y-0.5">
              {answered.map((row) => (
                <li key={row.ref} className="flex min-w-0 gap-1.5">
                  <span className="shrink-0 font-medium tabular-nums">{row.ref}</span>
                  <span className="min-w-0 break-words">{row.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {counts.owed ? (
          <p className="mt-1 text-muted-foreground">
            {counts.owed} {counts.owed === 1 ? "answer owed" : "answers owed"}
          </p>
        ) : null}
        {unlisted > 0 ? <p className="mt-1 text-muted-foreground">and {unlisted} more</p> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
