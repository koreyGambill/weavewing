import { ArrowDownLeftIcon, ArrowUpRightIcon, CircleHelpIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function sidebarComputerLocalityLabel(
  onThisComputer: boolean | null,
  environmentLabel?: string | null,
): string {
  if (onThisComputer === null) return "Computer locality unknown";
  if (onThisComputer) return "On this computer";
  return environmentLabel ? `On another computer · ${environmentLabel}` : "On another computer";
}

/** Shows the physical computer's locality with the same marker in rows and filters. */
export function SidebarComputerLocalityIcon({
  onThisComputer,
  label,
}: {
  onThisComputer: boolean | null;
  label: string;
}) {
  const Icon =
    onThisComputer === null
      ? CircleHelpIcon
      : onThisComputer
        ? ArrowDownLeftIcon
        : ArrowUpRightIcon;
  const color =
    onThisComputer === null
      ? "text-muted-foreground"
      : onThisComputer
        ? "text-success-foreground"
        : "text-warning-foreground";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={`inline-flex shrink-0 items-center ${color}`}
          />
        }
      >
        <Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
