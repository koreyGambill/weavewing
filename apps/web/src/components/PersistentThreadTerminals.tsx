import { type ResolvedKeybindingsConfig, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { memo } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import type { TerminalContextSelection } from "../lib/terminalContext";
import type { RightPanelSurface } from "../rightPanelStore";
import { useProject, useQuietThreadShell } from "../state/entities";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import ThreadTerminalTile from "./ThreadTerminalTile";
import { resolveTerminalWorktreePath } from "./ChatView.logic";

/** Launch location when a script overrides the thread's checkout. */
export type PersistentTerminalLaunchContext = {
  readonly cwd: string;
  readonly worktreePath: string | null;
};

export interface PersistentThreadTerminalPanelProps {
  visible: boolean;
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
}

export const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  visible,
  threadRef,
  surface,
  launchContext,
  keybindings,
  onAddTerminalContext,
  onCloseTerminal,
}: PersistentThreadTerminalPanelProps) {
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions?.find((session) => session.target.terminalId === surface.resourceId)
      ?.state.summary ?? null;
  const worktreePath = resolveTerminalWorktreePath({
    launchContext,
    summary: activeSummary,
    threadWorktreePath,
  });
  const cwd =
    launchContext?.cwd ??
    activeSummary?.cwd ??
    (project ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }) : null);
  const runtimeEnv = project
    ? projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath })
    : {};
  if (!project || !cwd) return null;

  return (
    <ThreadTerminalTile
      visible={visible}
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      terminalId={surface.resourceId}
      terminalLabel={resolveTerminalSessionLabel(surface.resourceId, activeSummary)}
      onCloseTerminal={onCloseTerminal}
      onAddTerminalContext={onAddTerminalContext}
      keybindings={keybindings}
    />
  );
});
