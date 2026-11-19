import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon } from "lucide-react";
import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import SideChatPane from "./SideChatPane";

export function InlineSideChat({
  child,
  parentRef,
  parentPanel,
  expanded,
  onToggle,
}: {
  child: OrchestrationV2ThreadShell;
  parentRef: ScopedThreadRef;
  parentPanel: SideChatParentPanel;
  expanded: boolean;
  onToggle: () => void;
}) {
  const quote = child.lineage.sideChatAnchor?.text;
  return (
    <div className="min-w-0 border-l-2 border-info/60 pl-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              onClick={onToggle}
            />
          }
        >
          <GitBranchIcon aria-hidden="true" />
          <span className="max-w-24 truncate">{child.title}</span>
          <span className="max-w-48 truncate font-normal text-muted-foreground">{quote}</span>
          {expanded ? (
            <ChevronDownIcon aria-hidden="true" />
          ) : (
            <ChevronRightIcon aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup className="max-w-xs whitespace-pre-wrap wrap-anywhere">{quote}</TooltipPopup>
      </Tooltip>
      {expanded ? (
        <div
          className={cn(
            "mt-1 min-w-0 overflow-hidden rounded-md border border-border bg-background",
            child.latestUserMessageAt === null ? "h-56" : "h-[min(32rem,70dvh)]",
          )}
        >
          <SideChatPane
            parentRef={parentRef}
            threadId={child.id}
            parentPanel={parentPanel}
            inline
          />
        </div>
      ) : null}
    </div>
  );
}
