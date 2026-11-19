import type { ScopedThreadRef } from "@t3tools/contracts";
import { ThreadReviewsButton } from "../reviews/ThreadReviewsButton";
import { PanelBottomIcon, SquareMenuIcon } from "lucide-react";
import { memo } from "react";
import { COMPOSER_ICON_COLOR } from "./ComposerControl";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PanelLayoutControlsProps {
  workspaceThreadRef?: ScopedThreadRef | undefined;
  showThreadPanelControl?: boolean;
  compact?: boolean;
  showTerminalControl?: boolean;
  showReviewsControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverHandle?: ReturnType<typeof PopoverCreateHandle>;
  threadPanelShortcutLabel: string | null;
  onToggleTerminal: () => void;
  onToggleThreadPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  workspaceThreadRef,
  showThreadPanelControl = true,
  compact = false,
  showTerminalControl = true,
  showReviewsControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  threadPanelOpen,
  threadPanelPresentation,
  threadPanelPopoverHandle,
  threadPanelShortcutLabel,
  onToggleTerminal,
  onToggleThreadPanel,
}: PanelLayoutControlsProps) {
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size={compact ? "micro" : "sm"}
    >
      <SquareMenuIcon
        className={compact ? `size-4 opacity-100 ${COMPOSER_ICON_COLOR}` : "size-4"}
      />
    </Toggle>
  );
  const threadPanelControl = (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" data-thread-panel-toggle />}>
        {threadPanelPresentation === "popover" ? (
          <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />
        ) : (
          threadPanelToggle
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Toggle thread details
        {threadPanelShortcutLabel ? ` (${threadPanelShortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {showThreadPanelControl ? threadPanelControl : null}
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Open terminal tab"
              variant="ghost"
              size={compact ? "micro" : "sm"}
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Open terminal tab${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {showReviewsControl && workspaceThreadRef ? (
        <ThreadReviewsButton threadRef={workspaceThreadRef} />
      ) : null}
    </div>
  );
});
