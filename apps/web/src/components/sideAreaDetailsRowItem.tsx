import type { ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightIcon } from "lucide-react";

import { useToolSidebarStore } from "../toolSidebarStore";
import { ComposerControl } from "./chat/ComposerControl";
import type { ComposerRowItem } from "./chat/composerRowItems";
import { useSelectedThreadRef } from "./threadToolsHost";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The row item that opens or closes the side panel on this thread's Details. It stays in the row
 * at every width.
 */
export function sideAreaDetailsRowItem(threadRef: ScopedThreadRef | null): ComposerRowItem {
  return {
    id: "details",
    priority: null,
    hidden: threadRef === null,
    renderRowItem: () => (threadRef ? <DetailsToggle threadRef={threadRef} /> : null),
  };
}

function DetailsToggle({ threadRef }: { threadRef: ScopedThreadRef }) {
  const selected = useSelectedThreadRef();
  const pressed = useToolSidebarStore((state) => {
    const shown = state.locked ?? selected;
    return (
      state.open &&
      state.view === "details" &&
      shown?.environmentId === threadRef.environmentId &&
      shown.threadId === threadRef.threadId
    );
  });
  const label = pressed ? "Close thread details" : "Open thread details";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex" />}>
        <ComposerControl
          size="xs"
          data-side-area-toggle
          aria-label={label}
          aria-pressed={pressed}
          aria-controls="side-area"
          onClick={() =>
            useToolSidebarStore
              .getState()
              .dispatch({ type: "toggleView", view: "details", thread: threadRef })
          }
        >
          <PanelRightIcon />
        </ComposerControl>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
