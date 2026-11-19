import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";

/** Moves an open drawer's placements into terminal areas without touching its sessions. */
export function LegacyTerminalTileBridge({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const terminalState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Migrates persisted drawer placements when the tiled client mounts.
  useEffect(() => {
    if (!terminalState.terminalOpen) return;
    const panel = useRightPanelStore.getState();
    const currentSurfaces = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces;
    for (const terminalId of terminalState.terminalIds) {
      const owner = currentSurfaces().find(
        (surface) => surface.kind === "terminal" && surface.resourceId === terminalId,
      );
      if (!owner) panel.openTerminal(threadRef, terminalId);
    }
    const activeSurface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces.find(
      (surface) =>
        surface.kind === "terminal" && surface.resourceId === terminalState.activeTerminalId,
    );
    if (activeSurface) {
      panel.activateSurface(threadRef, activeSurface.id);
    }
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);
  }, [threadRef, terminalState]);

  return null;
}
