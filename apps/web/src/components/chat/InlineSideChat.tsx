import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, PanelsTopLeftIcon } from "lucide-react";
import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import SideChatPane from "./SideChatPane";

const RAIL_COLORS = ["border-info/60", "border-success/60", "border-warning/60"] as const;

export function InlineSideChat({
  child,
  depth,
  parentRef,
  parentPanel,
  expanded,
  onToggle,
  onFocusParentComposer,
}: {
  child: OrchestrationV2ThreadShell;
  depth: number;
  parentRef: ScopedThreadRef;
  parentPanel: SideChatParentPanel;
  expanded: boolean;
  onToggle: () => void;
  onFocusParentComposer: () => void;
}) {
  const tabOpen = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, parentPanel.hostRef).surfaces.some(
      (surface) => surface.kind === "side-chat" && surface.threadId === child.id,
    ),
  );
  const openTab = () => useRightPanelStore.getState().openSideChat(parentPanel.hostRef, child.id);
  const quote = child.lineage.sideChatAnchor?.text;
  return (
    <div className={cn("min-w-0 border-l pl-1", RAIL_COLORS[(depth - 1) % RAIL_COLORS.length])}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={tabOpen ? undefined : expanded}
              onClick={tabOpen ? openTab : onToggle}
            />
          }
        >
          <GitBranchIcon aria-hidden="true" />
          <span className="max-w-24 truncate">{child.title}</span>
          <span className="max-w-48 truncate font-normal text-muted-foreground">{quote}</span>
          {tabOpen ? (
            <PanelsTopLeftIcon aria-hidden="true" />
          ) : expanded ? (
            <ChevronDownIcon aria-hidden="true" />
          ) : (
            <ChevronRightIcon aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup className="max-w-xs whitespace-pre-wrap wrap-anywhere">
          {tabOpen ? "Show side chat tab" : quote}
        </TooltipPopup>
      </Tooltip>
      {expanded && !tabOpen ? (
        <SideChatPane
          hostRef={parentPanel.hostRef}
          inlineParentRef={parentRef}
          inlineDepth={depth}
          onFocusParentComposer={onFocusParentComposer}
          onOpenTab={openTab}
          threadId={child.id}
          parentPanel={parentPanel}
        />
      ) : null}
    </div>
  );
}
