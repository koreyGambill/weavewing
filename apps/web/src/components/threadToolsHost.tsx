import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams, useRouterState } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createContext, use, useState, type ReactNode } from "react";
import { selectThreadTileLayout, useRightPanelStore } from "../rightPanelStore";
import { selectContextThread } from "../threadContextSidebar";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useToolSidebarStore } from "../toolSidebarStore";
import { resolveDetailsDestination, resolveSideAreaThread } from "./ToolSidebar.logic";
import type { ViewDraft } from "../views/viewRegistry";
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
  return selectContextThread(owner, layout, surfaces ?? []);
}

/** The thread the side area's thread views show: a locked thread, else the selected one. */
export function useSideAreaThreadRef(): ScopedThreadRef | null {
  const selected = useSelectedThreadRef();
  const locked = useToolSidebarStore((state) => state.locked);
  return resolveSideAreaThread(locked, selected);
}

type Slot = HTMLDivElement | null;
const SideAreaDetails = createContext<(element: Slot) => void>(() => {});
type TileDetails = { readonly threadRef: ScopedThreadRef; readonly element: HTMLDivElement };
const TileDetails = createContext<(details: TileDetails | null, element: Slot) => void>(() => {});
const NO_TILE_DETAILS: ReadonlyArray<TileDetails> = [];

/** Gives the conversation's details card to the host whose Details view shows its thread. */
export function ThreadToolsHost({ children }: { children: ReactNode }) {
  const selected = useSelectedThreadRef();
  const sideThreadRef = useSideAreaThreadRef();
  const sideOpen = useToolSidebarStore((state) => state.open);
  const sideView = useToolSidebarStore((state) => state.view);
  const [sideDetails, setSideDetails] = useState<Slot>(null);
  const [tileDetails, setTileDetailsState] = useState(NO_TILE_DETAILS);
  const [setTileDetails] = useState(
    () => (details: TileDetails | null, element: Slot) =>
      setTileDetailsState((current) => {
        const removed = details ? details.element : element;
        const rest = current.filter((entry) => entry.element !== removed);
        return details ? [...rest, details] : rest.length < current.length ? rest : current;
      }),
  );
  const destination = resolveDetailsDestination(
    [
      ...tileDetails.map((details) => ({ ...details, host: "tile" as const })),
      sideOpen && sideView === "details" && sideThreadRef && sideDetails
        ? { threadRef: sideThreadRef, element: sideDetails, host: "panel" }
        : null,
    ],
    selected,
  );
  return (
    <SideAreaDetails value={setSideDetails}>
      <TileDetails value={setTileDetails}>
        <ThreadDetailsDestination value={destination}>{children}</ThreadDetailsDestination>
      </TileDetails>
    </SideAreaDetails>
  );
}

/** The side area's setter for its Details element, which the host gives the card to. */
export function useSideAreaDetailsSetter() {
  return use(SideAreaDetails);
}

/** A view tile's setter for its Details element: `(details, null)` adds it, `(null, element)` removes it. */
export function useTileDetailsSetter() {
  return use(TileDetails);
}

/** The route's draft when no thread is selected, for views that preview a draft. */
export function useRouteDraft(threadRef: ScopedThreadRef | null): ViewDraft | null {
  const { draftId: routeDraftId } = useParams({ strict: false });
  const draftId = routeDraftId === undefined ? undefined : DraftId.make(routeDraftId);
  const session = useComposerDraftStore((store) =>
    threadRef === null && draftId ? store.getDraftSession(draftId) : null,
  );
  return draftId && session
    ? { draftId, threadRef: scopeThreadRef(session.environmentId, session.threadId) }
    : null;
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
