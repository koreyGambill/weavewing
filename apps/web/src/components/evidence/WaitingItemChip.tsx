import type { WaitingItemContextRecord } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A Discuss reference: which waiting item the message is about, with its title on hover. */
export function WaitingItemChip({ record }: { readonly record: WaitingItemContextRecord }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{record.label}</TooltipTrigger>
      <TooltipPopup className="max-w-80">
        {record.ref}: {record.title}
      </TooltipPopup>
    </Tooltip>
  );
}
