import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The controls rows under Inspect's tab switcher; every tab shares its inset so Refresh never moves. */
export function InspectControls({ children }: { children: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-col gap-1 border-b border-border px-2.5 py-1.5">
      {children}
    </header>
  );
}

export function InspectRefreshButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <RefreshCwIcon />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
