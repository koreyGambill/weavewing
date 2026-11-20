import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";

import { Button } from "../ui/button";
import { PopoverTrigger, type PopoverCreateHandle } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ChatFooterLineage({
  lineageHandle,
  agents,
}: {
  lineageHandle: ReturnType<typeof PopoverCreateHandle>;
  agents: ReadonlyArray<OrchestrationV2Subagent> | undefined;
}) {
  let working = 0;
  let failed = 0;
  let past = 0;
  for (const { status } of agents ?? []) {
    if (isOrchestrationV2WorkActive(status)) working++;
    else if (status === "failed") failed++;
    else past++;
  }
  const hasAgents = working + failed + past > 0;
  const summary = `${working} working, ${failed} failed, ${past} past`;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <PopoverTrigger
          data-chat-lineage
          handle={lineageHandle}
          render={
            <Button
              size={hasAgents ? "compact" : "icon-sm"}
              variant="ghost-muted"
              aria-label={hasAgents ? `Lineage, ${summary}` : "Lineage"}
            />
          }
        >
          <NetworkIcon />
          {hasAgents ? (
            <span aria-hidden className="inline-flex items-center gap-0.5 tabular-nums">
              <span className={working > 0 ? "text-success-foreground" : "text-muted-foreground"}>
                {working}
              </span>
              <span className="text-muted-foreground">/</span>
              <span className={failed > 0 ? "text-error-foreground" : "text-muted-foreground"}>
                {failed}
              </span>
              <span className="text-muted-foreground">/</span>
              <span className="text-muted-foreground">{past}</span>
            </span>
          ) : null}
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipPopup>{hasAgents ? summary : "Thread lineage and side chats"}</TooltipPopup>
    </Tooltip>
  );
}
