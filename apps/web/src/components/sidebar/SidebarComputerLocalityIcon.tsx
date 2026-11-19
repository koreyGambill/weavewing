import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Shows the physical computer's locality with the same marker in rows and filters. */
export function SidebarComputerLocalityIcon({
  onThisComputer,
  label,
}: {
  onThisComputer: boolean;
  label: string;
}) {
  const Icon = onThisComputer ? ArrowDownLeftIcon : ArrowUpRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={`inline-flex shrink-0 items-center ${onThisComputer ? "text-success-foreground" : "text-warning-foreground"}`}
          />
        }
      >
        <Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
