import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../../rightPanelStore";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { closingTerminalIds, holdTerminalIdWhileClosing } from "./closingTerminals";

/** Where a new terminal starts. Omitted fields fall back to the thread's project and worktree. */
export interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

/**
 * The next free terminal id in a thread. Server lists lag and colliding ids share a PTY; without
 * read access, ids get a suffix so they cannot land on sessions the user cannot see.
 */
export function allocateThreadTerminalId(
  threadRef: ScopedThreadRef | null,
  knownSessions: ReadonlyArray<KnownTerminalSession> | null,
  drawerTerminalIds: readonly string[],
  panelSurfaces: readonly RightPanelSurface[],
): string {
  const ids = new Set([
    ...(knownSessions ?? []).map((session) => session.target.terminalId),
    ...drawerTerminalIds,
    ...panelSurfaces.flatMap((surface) =>
      surface.kind === "terminal" ? [surface.resourceId] : [],
    ),
    ...(threadRef ? closingTerminalIds(threadRef) : []),
  ]);
  const canReuse =
    knownSessions !== null &&
    threadRef !== null &&
    readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
  return nextTerminalId([...ids], canReuse ? undefined : randomUUID());
}

/** Allocate terminal ids and launch locations centrally so all surfaces share one view of sessions. */
export function useThreadTerminalActions(threadRef: ScopedThreadRef | null) {
  const openTerminalCommand = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalCommand = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const knownSessions = useKnownTerminalSessions({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  const drawerTerminalIds = useTerminalUiStateStore(
    (state) => selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalIds,
  );
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );

  const canWrite = () =>
    threadRef !== null && readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);

  const allocateTerminalId = () =>
    allocateThreadTerminalId(threadRef, knownSessions, drawerTerminalIds, panelSurfaces);

  const defaultLaunchLocation = (): TerminalLaunchLocation | null =>
    project
      ? {
          cwd: projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: threadWorktreePath,
          }),
          worktreePath: threadWorktreePath,
        }
      : null;

  /** place mounts the destination before the server open resolves. */
  const launchTerminal = (input: {
    readonly place: (terminalId: string) => void;
    readonly terminalId?: string;
    readonly location?: TerminalLaunchLocation | null;
    readonly extraEnv?: Record<string, string>;
    readonly stopOnSettle?: boolean;
    readonly size?: { readonly cols: number; readonly rows: number };
  }) => {
    if (!threadRef || !canWrite() || !project) return null;
    const location = input.location ?? defaultLaunchLocation();
    if (!location) return null;
    const terminalId = input.terminalId ?? allocateTerminalId();
    input.place(terminalId);
    const result = openTerminalCommand({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId,
        cwd: location.cwd,
        ...(location.worktreePath !== null ? { worktreePath: location.worktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: location.worktreePath,
          ...(input.extraEnv ? { extraEnv: input.extraEnv } : {}),
        }),
        ...input.size,
        ...(input.stopOnSettle !== undefined ? { stopOnSettle: input.stopOnSettle } : {}),
      },
    });
    return { terminalId, result };
  };

  /**
   * Ends a session and deletes its history. A failed close falls back to typing `exit`.
   * `sessionId` names the shell the caller saw; it defaults to the one the server last listed.
   */
  const closeTerminalSession = (
    terminalId: string,
    target = threadRef,
    sessionId?: string | null,
  ) => {
    if (!target || !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)) return;
    const environmentId = target.environmentId;
    const threadId = target.threadId;
    const expectedSessionId =
      sessionId ??
      (target.environmentId === threadRef?.environmentId && target.threadId === threadRef.threadId
        ? knownSessions?.find((session) => session.target.terminalId === terminalId)?.state.summary
            ?.sessionId
        : undefined);
    void holdTerminalIdWhileClosing(target, terminalId, async () => {
      const closeResult = await closeTerminalCommand({
        environmentId,
        input: {
          threadId,
          terminalId,
          deleteHistory: true,
          ...(expectedSessionId ? { sessionId: expectedSessionId } : {}),
        },
      });
      if (
        closeResult._tag === "Failure" &&
        !isAtomCommandInterrupted(closeResult) &&
        readEnvironmentScope(environmentId, AuthTerminalOperateScope)
      ) {
        await writeTerminal({ environmentId, input: { threadId, terminalId, data: "exit\n" } });
      }
    });
  };

  const writeToTerminal = (terminalId: string, data: string) => {
    if (!threadRef || !canWrite()) return null;
    return writeTerminal({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, terminalId, data },
    });
  };

  return {
    canWrite: useStableCallback(canWrite),
    allocateTerminalId: useStableCallback(allocateTerminalId),
    launchTerminal: useStableCallback(launchTerminal),
    closeTerminalSession: useStableCallback(closeTerminalSession),
    writeToTerminal: useStableCallback(writeToTerminal),
  };
}
