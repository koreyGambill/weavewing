import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Maximize2 } from "lucide-react";
import { useEffect, useState } from "react";

import { observeResize } from "../../lib/observeResize";
import { selectThreadTileLayout, useRightPanelStore } from "../../rightPanelStore";
import { DeferEnvironmentQueries } from "../../state/query";
import { getTileGroups } from "../../threadTileLayout";
import { viewDefinition } from "../../views/viewRegistry";
import { viewTileThread, type ViewSurface } from "../../views/viewTiles.logic";
import { useTileDetailsSetter } from "../threadToolsHost";
import { LockedThreadBar, useLockedThreadState } from "../ToolSidebar";
import { resolveViewLayout, SIDE_AREA_WIDE_MEDIA_QUERY } from "../ToolSidebar.logic";
import { SIDE_AREA_SETTLE_MS } from "../ToolSidebar";
import { Button } from "../ui/button";

// The workspace whose selection last rested; a view tile in it loads at once.
let settledWorkspaceKey: string | null = null;

/**
 * A side panel view in a tile. It mounts only while its tab shows, so hiding the tab cancels its
 * requests, and after a thread switch it renders held data until the selection rests.
 */
export function ViewTile(props: {
  surface: ViewSurface;
  owner: ScopedThreadRef;
  visible: boolean;
}) {
  return props.visible ? <ViewTileBody surface={props.surface} owner={props.owner} /> : null;
}

function ViewTileBody({ surface, owner }: { surface: ViewSurface; owner: ScopedThreadRef }) {
  const definition = viewDefinition(surface.viewId);
  const thread = viewTileThread(surface, owner);
  const lockedState = useLockedThreadState(surface.threadRef ?? null);
  const ownerKey = scopedThreadKey(owner);
  const [deferred, setDeferred] = useState(() => settledWorkspaceKey !== ownerKey);
  const [width, setWidth] = useState(0);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const setTileDetails = useTileDetailsSetter();
  const [measure] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    setWidth(node.clientWidth);
    return observeResize(node, () => setWidth(node.clientWidth));
  });
  const [setDetails] = useState(() => {
    let registered: HTMLDivElement | null = null;
    return (element: HTMLDivElement | null) => {
      if (element && thread) {
        registered = element;
        setTileDetails({ threadRef: thread, element }, null);
      } else if (!element) {
        setTileDetails(null, registered);
        registered = null;
      }
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A timer decides when a run of thread switches has stopped.
  useEffect(() => {
    if (!deferred) return;
    const timer = window.setTimeout(() => {
      settledWorkspaceKey = ownerKey;
      setDeferred(false);
    }, SIDE_AREA_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [deferred, ownerKey]);

  const deleted = lockedState?.kind === "deleted";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A view of a deleted thread has nothing to show, so its tab closes once the deletion is known.
  useEffect(() => {
    if (deleted) useRightPanelStore.getState().closeSurface(owner, surface.id);
  }, [deleted, owner, surface.id]);

  const narrow = width > 0 && width < definition.minWidthPx;
  const layout = narrow
    ? "compact"
    : resolveViewLayout(definition.compactBelowPx, {
        wide: window.matchMedia(SIDE_AREA_WIDE_MEDIA_QUERY).matches,
        width,
      });
  const openFullSize = () => {
    const group = getTileGroups(
      selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, owner),
    ).find((entry) => entry.tabs.includes(surface.id));
    if (group) {
      useRightPanelStore.getState().applyTileAction(owner, { type: "maximize", groupId: group.id });
    }
  };

  return (
    <div
      ref={measure}
      data-view-tile={surface.viewId}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {lockedState ? (
        <LockedThreadBar
          state={lockedState}
          onUnlock={() => useRightPanelStore.getState().closeSurface(owner, surface.id)}
        />
      ) : null}
      {narrow ? (
        <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
          <Button size="xs" variant="outline" onClick={openFullSize}>
            <Maximize2 />
            Open full size
          </Button>
          <div ref={setActions} className="ms-auto flex items-center gap-1" />
        </div>
      ) : (
        <div
          ref={setActions}
          className="flex shrink-0 items-center justify-end gap-1 border-b px-1.5 py-1 empty:hidden"
        />
      )}
      <DeferEnvironmentQueries value={deferred}>
        {definition.render({
          target: { threadRef: thread ?? owner, draft: null },
          layout,
          host: "tile",
          width,
          slots: { actions, setDetails },
        })}
      </DeferEnvironmentQueries>
    </div>
  );
}
