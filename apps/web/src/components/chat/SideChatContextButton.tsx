import { RefreshCwIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toggleSideChatRefresh, useSideChatRefreshArmed } from "./sideChatContextRefresh";

export function SideChatContextButton(props: {
  readonly threadKey: string;
  readonly showLabel?: boolean;
}) {
  const armed = useSideChatRefreshArmed(props.threadKey);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={props.showLabel ? "xs" : "icon-xs"}
            variant={armed ? "secondary" : "ghost"}
            aria-label="Get newest context"
            aria-pressed={armed}
            onClick={() => toggleSideChatRefresh(props.threadKey)}
          >
            <RefreshCwIcon />
            {props.showLabel ? "Get newest context" : null}
          </Button>
        }
      />
      <TooltipPopup>
        {armed ? "Newest context will accompany your next message" : "Get newest context"}
      </TooltipPopup>
    </Tooltip>
  );
}
