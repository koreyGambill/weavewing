import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, PanelsTopLeftIcon } from "lucide-react";
import {
  focusThreadDraft,
  type InlineSideChatExpansion,
  type SideChatParentPanel,
} from "~/lib/sideChatPane";
import { useSideChatShells } from "~/state/entities";
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
  expansion,
  onFocusParentComposer,
}: {
  child: OrchestrationV2ThreadShell;
  depth: number;
  parentRef: ScopedThreadRef;
  parentPanel: SideChatParentPanel;
  expansion: InlineSideChatExpansion;
  onFocusParentComposer: () => void;
}) {
  const tab = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, parentPanel.hostRef).surfaces.find(
      (surface) => surface.kind === "side-chat" && surface.threadId === child.id,
    ),
  );
  const openTab = () => useRightPanelStore.getState().openSideChat(parentPanel.hostRef, child.id);
  const expanded = expansion.children.has(child.id);
  const onToggle = () => expansion.setOpen(child.id, !expanded);
  const childRef = scopeThreadRef(parentRef.environmentId, child.id);
  const showPane = expanded && !tab;
  const showInline = () => {
    if (tab) useRightPanelStore.getState().closeSurface(parentPanel.hostRef, tab.id);
    expansion.setOpen(child.id, true);
  };
  const children = useSideChatShells(showPane ? null : childRef).filter(
    (branch) => branch.lineage.contextArchive === undefined,
  );
  const quote = child.lineage.sideChatAnchor?.text;
  return (
    <div
      className={cn(
        "relative min-w-0 border-l pl-2",
        RAIL_COLORS[(depth - 1) % RAIL_COLORS.length],
      )}
    >
      <button
        type="button"
        aria-label={`Toggle ${quote === undefined ? "side chat" : "drill-in"}: ${child.title}`}
        aria-expanded={showPane}
        className="absolute inset-y-0 left-[-1px] z-10 w-1.5 cursor-pointer rounded-sm hover:bg-current/15 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => {
          if (tab) showInline();
          else onToggle();
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={tab ? undefined : expanded}
              onClick={tab ? openTab : onToggle}
            />
          }
        >
          <GitBranchIcon aria-hidden="true" />
          <span className="max-w-24 truncate">{child.title}</span>
          <span className="max-w-48 truncate font-normal text-muted-foreground">{quote}</span>
          {tab ? (
            <PanelsTopLeftIcon aria-hidden="true" />
          ) : expanded ? (
            <ChevronDownIcon aria-hidden="true" />
          ) : (
            <ChevronRightIcon aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup className="max-w-xs whitespace-pre-wrap wrap-anywhere">
          {tab ? "Show side chat tab" : (quote ?? child.title)}
        </TooltipPopup>
      </Tooltip>
      {showPane ? (
        <SideChatPane
          hostRef={parentPanel.hostRef}
          inlineParentRef={parentRef}
          inlineDepth={depth}
          inlineExpansion={expansion}
          onFocusParentComposer={onFocusParentComposer}
          onOpenTab={openTab}
          threadId={child.id}
          parentPanel={parentPanel}
        />
      ) : null}
      {children.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {children.map((branch) => (
            <InlineSideChat
              key={branch.id}
              child={branch}
              depth={depth + 1}
              expansion={expansion}
              parentRef={childRef}
              parentPanel={parentPanel}
              onFocusParentComposer={() => {
                showInline();
                focusThreadDraft(childRef);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
