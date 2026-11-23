import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalReadScope,
  isDropdownTerminalThreadId,
  type ScopedThreadRef,
  type TerminalMoveInput,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";

import {
  dropdownTerminalRef,
  dropdownTerminalTabFor,
  newDropdownTerminalTabId,
} from "../../dropdownTerminal.logic";
import { type DropdownTerminalTarget, useDropdownTerminalStore } from "../../dropdownTerminalStore";
import { focusTerminal } from "../../lib/terminalFocus";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { readEnvironmentScope } from "../../state/session";
import { knownTerminalSessionsAtom } from "../../state/terminalSessions";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { CONVERSATION_TAB_ID } from "../../threadTileLayout";
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
    if (isDropdownTerminalThreadId(from.threadId)) {
      dropdown.selectTab(from.threadId);
      if (!dropdown.open) dropdown.toggle();
    }
    return null;
  }
  const movedId = result.value.terminalId;
  store.openTerminal(to.threadRef, movedId, {
    cwd: result.value.cwd,
    worktreePath: to.worktreePath,
  });
  return movedId;
}

export async function moveTerminalToDropdown(input: {
  readonly from: ScopedThreadRef;
  readonly terminalId: string;
  readonly target: DropdownTerminalTarget;
  readonly move: Parameters<typeof moveTerminalTab>[0]["move"];
}): Promise<void> {
  const existing = dropdownTerminalTabFor(
    useDropdownTerminalStore.getState(),
    input.target.environmentId,
  );
  const tabId = existing?.id ?? newDropdownTerminalTabId();
  const threadRef = dropdownTerminalRef(input.target.environmentId, tabId);
  const movedId = await moveTerminalTab({
    from: input.from,
    terminalId: input.terminalId,
    to: { threadRef, worktreePath: null },
    move: input.move,
  });
  if (movedId === null) return;
  // An empty drop-down keeps a conversation tab until its first terminal replaces it.
  useRightPanelStore
    .getState()
    .applyTileAction(threadRef, { type: "close-tab", tabId: CONVERSATION_TAB_ID });
  const dropdown = useDropdownTerminalStore.getState();
  if (existing) dropdown.selectTab(tabId);
  else dropdown.addTab(input.target, tabId);
  if (!dropdown.open) dropdown.toggle();
  focusTerminal(threadRef, movedId);
}
