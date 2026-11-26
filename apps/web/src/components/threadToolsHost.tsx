import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { createContext, use, useState, type ReactNode } from "react";
import { selectThreadTileLayout, useRightPanelStore } from "../rightPanelStore";
import { selectContextThread } from "../threadContextSidebar";
import { useThreadContextSidebarStore } from "../threadContextSidebarStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useToolSidebarStore } from "../toolSidebarStore";
import { resolveSideAreaThread } from "./ToolSidebar.logic";
import { ThreadDetailsDestination } from "./chat/ThreadDetailsDestination";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The selected thread: the route's, or the side chat in its focused tile. */
export function useSelectedThreadRef(): ScopedThreadRef | null {
  const owner = useRouterState({
    select: (state) => resolveThreadRouteRef(state.matches.at(-1)?.params ?? {}),
  });
  const surfaces = useRightPanelStore((state) =>
    owner ? state.byThreadKey[`${owner.environmentId}:${owner.threadId}`]?.surfaces : undefined,
  );
  const layout = useRightPanelStore((state) =>
    owner ? selectThreadTileLayout(state.byThreadKey, owner) : null,
  );
  return selectContextThread(owner, layout, surfaces ?? [], null);
}

/** The thread the sidebar's tools follow: a pinned thread, else the focused tile's. */
export function useThreadToolsTarget(): ScopedThreadRef | null {
  const selected = useSelectedThreadRef();
  const pinned = useThreadContextSidebarStore((state) => state.pinned);
  return pinned ?? selected;
}

/** The thread the side area's thread views show: a locked thread, else the selected one. */
export function useSideAreaThreadRef(): ScopedThreadRef | null {
  const selected = useSelectedThreadRef();
  const locked = useToolSidebarStore((state) => state.locked);
  return resolveSideAreaThread(locked, selected);
}

type Slot = HTMLDivElement | null;
interface SlotsValue {
  setDetails: (element: Slot) => void;
  actions: Slot;
  setActions: (element: Slot) => void;
}
const Slots = createContext<SlotsValue>({
  setDetails: () => {},
  actions: null,
  setActions: () => {},
});
const SideAreaDetails = createContext<(element: Slot) => void>(() => {});

/**
 * Holds the places the open tool renders into outside its own panel: its heading row's button slot,
 * and the Details view that the conversation's details card moves into. The card shows in one
 * place at a time, so the side area's Details takes it over the rail's.
 */
export function ThreadToolsHost({ children }: { children: ReactNode }) {
  const threadRef = useThreadToolsTarget();
  const view = useThreadContextSidebarStore((state) => state.view);
  const sideThreadRef = useSideAreaThreadRef();
  const sideOpen = useToolSidebarStore((state) => state.open);
  const sideView = useToolSidebarStore((state) => state.view);
  const [details, setDetails] = useState<Slot>(null);
  const [sideDetails, setSideDetails] = useState<Slot>(null);
  const [actions, setActions] = useState<Slot>(null);
  const destination =
    sideOpen && sideView === "details" && sideThreadRef && sideDetails
      ? { threadRef: sideThreadRef, element: sideDetails }
      : view === "details" && threadRef && details
        ? { threadRef, element: details }
        : null;
  return (
    <Slots value={{ setDetails, actions, setActions }}>
      <SideAreaDetails value={setSideDetails}>
        <ThreadDetailsDestination value={destination}>{children}</ThreadDetailsDestination>
      </SideAreaDetails>
    </Slots>
  );
}

/** Gives the side area's view its own heading-button slot and Details element. */
export function SideAreaSlots({
  actions,
  setActions,
  children,
}: {
  actions: Slot;
  setActions: (element: Slot) => void;
  children: ReactNode;
}) {
  const setDetails = use(SideAreaDetails);
  return <Slots value={{ setDetails, actions, setActions }}>{children}</Slots>;
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
