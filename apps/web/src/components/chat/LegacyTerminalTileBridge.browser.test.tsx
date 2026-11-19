import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import {
  migratePersistedTerminalUiStateStoreState,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "../../terminalUiStateStore";
import { LegacyTerminalTileBridge } from "./LegacyTerminalTileBridge";

it("moves drawer groups into areas, preserving existing owners and later legacy opens", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("terminal-tile-migration"),
    threadId: ThreadId.make("thread"),
  };
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  const drawer = useTerminalUiStateStore.getState();
  useTerminalUiStateStore.setState(
    migratePersistedTerminalUiStateStoreState(
      {
        terminalUiStateByThreadKey: {
          [scopedThreadKey(threadRef)]: {
            terminalOpen: true,
            terminalHeight: 280,
            terminalIds: ["shell-1", "shell-2", "shell-3"],
            activeTerminalId: "shell-3",
            terminalGroups: [
              {
                id: "legacy-split",
                terminalIds: ["shell-1", "shell-2"],
                splitDirection: "vertical",
              },
              { id: "legacy-tab", terminalIds: ["shell-3"] },
            ],
            activeTerminalGroupId: "legacy-tab",
          },
        },
      },
      4,
    ),
  );
  useRightPanelStore.getState().openTerminal(threadRef, "shell-1");
  const panelState = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  const drawerState = () =>
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    );

  // The bridge only migrates store placements and has no navigation.
  await using _screen = await render(<LegacyTerminalTileBridge threadRef={threadRef} />, {
    router: false,
  });
  await vi.waitFor(() => {
    expect(drawerState().terminalOpen).toBe(false);
    expect(panelState().surfaces).toEqual([
      {
        id: "terminal:shell-1",
        kind: "terminal",
        resourceId: "shell-1",
      },
      {
        id: "terminal:shell-2",
        kind: "terminal",
        resourceId: "shell-2",
      },
      {
        id: "terminal:shell-3",
        kind: "terminal",
        resourceId: "shell-3",
      },
    ]);
    expect(panelState().activeSurfaceId).toBe("terminal:shell-3");
    expect(drawerState().terminalIds).toEqual(["shell-1", "shell-2", "shell-3"]);
  });

  drawer.newTerminal(threadRef, "shell-4");
  await vi.waitFor(() => {
    expect(drawerState().terminalOpen).toBe(false);
    expect(
      panelState().surfaces.flatMap((surface) =>
        surface.kind === "terminal" ? [surface.resourceId] : [],
      ),
    ).toEqual(["shell-1", "shell-2", "shell-3", "shell-4"]);
    expect(panelState().activeSurfaceId).toBe("terminal:shell-4");
  });
});
