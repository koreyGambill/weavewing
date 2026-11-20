import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthTerminalOperateScope, type ScopedThreadRef } from "@t3tools/contracts";

import { markDraftTerminalUsed } from "../composerDraftStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { knownTerminalSessionsAtom } from "../state/terminalSessions";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

/** Capture resources before replacing the draft. Run the cleanup only if the store discarded it. */
export function prepareDraftWorkspaceCleanup(ref: ScopedThreadRef): () => void {
  const panels = useRightPanelStore.getState();
  const sessions = appAtomRegistry.get(knownTerminalSessionsAtom(ref.environmentId, ref.threadId));
  if (sessions?.some((session) => session.state.hasRunningSubprocess)) {
    markDraftTerminalUsed(ref);
  }
  const hasTerminals =
    Boolean(sessions?.length) ||
    selectThreadRightPanelState(panels.byThreadKey, ref).surfaces.some(
      (surface) => surface.kind === "terminal",
    );
  return () => {
    useTerminalUiStateStore.getState().clearTerminalUiState(ref);
    useRightPanelStore.getState().removeThread(ref);
    if (!hasTerminals || !readEnvironmentScope(ref.environmentId, AuthTerminalOperateScope)) return;
    void runAtomCommand(
      appAtomRegistry,
      terminalEnvironment.close,
      { environmentId: ref.environmentId, input: { threadId: ref.threadId, deleteHistory: true } },
      { reportFailure: false },
    );
  };
}
