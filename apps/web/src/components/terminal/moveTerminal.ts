import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalReadScope,
  DROPDOWN_TERMINAL_THREAD_ID,
  type ScopedThreadRef,
  type TerminalMoveInput,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";

import { useDropdownTerminalStore } from "../../dropdownTerminalStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { readEnvironmentScope } from "../../state/session";
import { knownTerminalSessionsAtom } from "../../state/terminalSessions";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { allocateThreadTerminalId } from "./useThreadTerminalActions";

/** Where a moved terminal lands: the workspace, and the checkout its tile attaches with. */
export interface TerminalMoveDestination {
  readonly threadRef: ScopedThreadRef;
  readonly worktreePath: string | null;
}

/**
 * Moves a terminal tab and its live session into another workspace on the same machine; the
 * shell, its processes and its scrollback carry over. Resolves to the terminal's new id, or null
 * when the tab stays where it was.
 */
export async function moveTerminalTab(input: {
  readonly from: ScopedThreadRef;
  readonly terminalId: string;
  readonly to: TerminalMoveDestination;
  readonly move: (target: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: TerminalMoveInput;
  }) => Promise<AtomCommandResult<TerminalSessionSnapshot, unknown>>;
}): Promise<string | null> {
  const { from, terminalId, to } = input;
  if (from.environmentId !== to.threadRef.environmentId) return null;
  const panels = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(panels.byThreadKey, from).surfaces.find(
    (entry) => entry.kind === "terminal" && entry.resourceId === terminalId,
  );
  if (!surface || surface.kind !== "terminal") return null;
  const toTerminalId = allocateThreadTerminalId(
    to.threadRef,
    readEnvironmentScope(to.threadRef.environmentId, AuthTerminalReadScope)
      ? appAtomRegistry.get(
          knownTerminalSessionsAtom(to.threadRef.environmentId, to.threadRef.threadId),
        )
      : null,
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      to.threadRef,
    ).terminalIds,
    selectThreadRightPanelState(panels.byThreadKey, to.threadRef).surfaces,
  );
  // The move event also drops the source tab for viewers that remain attached.
  panels.closeTerminal(from, surface.id, terminalId);
  const result = await input.move({
    environmentId: from.environmentId,
    input: {
      threadId: from.threadId,
      terminalId,
      toThreadId: to.threadRef.threadId,
      toTerminalId,
      worktreePath: to.worktreePath,
    },
  });
  const store = useRightPanelStore.getState();
  if (result._tag !== "Success") {
    store.openTerminal(from, terminalId, surface.launchContext);
    // Taking out its last tab hid the drop-down; the restored tab needs it shown again.
    const dropdown = useDropdownTerminalStore.getState();
    if (from.threadId === DROPDOWN_TERMINAL_THREAD_ID && !dropdown.open) dropdown.toggle();
    return null;
  }
  const movedId = result.value.terminalId;
  store.openTerminal(to.threadRef, movedId, {
    cwd: result.value.cwd,
    worktreePath: to.worktreePath,
  });
  return movedId;
}
