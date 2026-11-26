import {
  waitingOnUser,
  waitingTotal,
  type WaitingCounts,
  type WaitingItemSummary,
} from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WAITING_KIND_HEADING, groupWaitingItems, waitingChipLabel } from "./waitingStrip.logic";

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
}: {
  readonly counts: WaitingCounts;
  readonly waiting: ReadonlyArray<WaitingItemSummary> | undefined;
}) {
  const total = waitingTotal(counts);
  const label = waitingChipLabel(counts);
  const groups = groupWaitingItems(waiting);
  // The row carries a capped list, so a long backlog ends with how many it left out.
  const unlisted = Math.max(0, total - (waiting ?? []).filter(waitingOnUser).length);
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
                    {STATE_NOTE[item.state] ? (
                      <span className="text-muted-foreground"> ({STATE_NOTE[item.state]})</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {unlisted > 0 ? <p className="mt-1 text-muted-foreground">and {unlisted} more</p> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
