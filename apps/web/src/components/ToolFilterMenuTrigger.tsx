import { ListFilterIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./ui/button";
import { MenuRadioItemIndicator, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The filter-menu button every tool view shares; the variant, not the size, shows an active filter. */
export function ToolFilterMenuTrigger({
  label,
  tooltip = label,
  active,
}: {
  label: string;
  tooltip?: ReactNode;
  active: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <MenuTrigger
            render={
              <Button variant={active ? "secondary" : "ghost"} size="icon-sm" aria-label={label} />
            }
          />
        }
      >
        <ListFilterIcon />
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** A radio item's label with its check on the right, which the menu's radio items omit. */
export function CheckedLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center justify-between gap-4">
      {children}
      <MenuRadioItemIndicator />
    </span>
  );
}
