import { NetworkIcon } from "lucide-react";

import { Button } from "../ui/button";
import { PopoverTrigger, type PopoverCreateHandle } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ChatFooterLineage({
  lineageHandle,
  runningAgents,
}: {
  lineageHandle: ReturnType<typeof PopoverCreateHandle>;
  runningAgents: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <PopoverTrigger
          handle={lineageHandle}
          render={
            <Button
              size={runningAgents > 0 ? "compact" : "icon-sm"}
              variant="ghost-muted"
              aria-label={runningAgents > 0 ? `Lineage, ${runningAgents} running` : "Lineage"}
            />
          }
        >
          <NetworkIcon />
          {runningAgents > 0 ? runningAgents : null}
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipPopup>Thread lineage and side chats</TooltipPopup>
    </Tooltip>
  );
}
