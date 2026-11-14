import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { createContext, use, useState, type ReactNode } from "react";
import { selectThreadTileLayout, useRightPanelStore } from "../rightPanelStore";
import { selectContextThread } from "../threadContextSidebar";
import { useThreadContextSidebarStore } from "../threadContextSidebarStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import { ThreadDetailsDestination } from "./chat/ThreadDetailsDestination";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The thread the sidebar's tools follow: a pinned thread, else the focused tile's. */
export function useThreadToolsTarget(): ScopedThreadRef | null {
  const owner = useRouterState({
    select: (state) => resolveThreadRouteRef(state.matches.at(-1)?.params ?? {}),
  });
  const surfaces = useRightPanelStore((state) =>
    owner ? state.byThreadKey[`${owner.environmentId}:${owner.threadId}`]?.surfaces : undefined,
  );
  const layout = useRightPanelStore((state) =>
    owner ? selectThreadTileLayout(state.byThreadKey, owner) : null,
  );
  const pinned = useThreadContextSidebarStore((state) => state.pinned);
  return selectContextThread(owner, layout, surfaces ?? [], pinned);
}

type Slot = HTMLDivElement | null;
const Slots = createContext<{
  details: Slot;
  setDetails: (element: Slot) => void;
  actions: Slot;
  setActions: (element: Slot) => void;
}>({ details: null, setDetails: () => {}, actions: null, setActions: () => {} });

/**
 * Holds the places the open tool renders into outside its own panel: its heading row's button slot,
 * and the Details view that the conversation's details card moves into.
 */
export function ThreadToolsHost({ children }: { children: ReactNode }) {
  const threadRef = useThreadToolsTarget();
  const view = useThreadContextSidebarStore((state) => state.view);
  const [details, setDetails] = useState<Slot>(null);
  const [actions, setActions] = useState<Slot>(null);
  return (
    <Slots value={{ details, setDetails, actions, setActions }}>
      <ThreadDetailsDestination
        value={view === "details" && threadRef && details ? { threadRef, element: details } : null}
      >
        {children}
      </ThreadDetailsDestination>
    </Slots>
  );
}

export function useThreadToolsSlots() {
  return use(Slots);
}

/** A button an open tool adds to its heading row. */
export function ToolHeaderButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
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
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
