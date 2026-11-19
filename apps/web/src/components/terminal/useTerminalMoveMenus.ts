import { AuthTerminalOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { useRouter } from "@tanstack/react-router";

import { dropdownTerminalMoveTargets, dropdownTerminalTarget } from "../../dropdownTerminal.logic";
import { isElectron } from "../../env";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { focusTerminal, focusTerminalOnNavigation } from "../../lib/terminalFocus";
import { useQuietThreadShells } from "../../state/entities";
import {
  readEnvironment,
  readPrimaryEnvironmentId,
  useEnvironment,
} from "../../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { moveTerminalTab, moveTerminalToDropdown } from "./moveTerminal";

export interface TerminalMoveOption {
  readonly id: string;
  readonly label: string;
  /** Why the option is unavailable, or a note on it; null shows nothing. */
  readonly detail: string | null;
  readonly disabled: boolean;
}

/** One terminal's move action, shared by the tile actions menu and the terminal context menu. */
export interface TerminalMoveMenu {
  readonly label: string;
  /** Listed as a submenu; null makes the label itself the action. */
  readonly options: ReadonlyArray<TerminalMoveOption> | null;
  /** Why the whole action is unavailable. */
  readonly disabledReason: string | null;
  readonly onMove: (optionId: string | null) => void;
}

/** "Move to thread…" for drop-down terminals: the shown thread first, then recent ones. */
export function useMoveToThreadMenu(input: {
  readonly dropdownRef: ScopedThreadRef;
  readonly machine: string;
}): (terminalId: string) => TerminalMoveMenu {
  const router = useRouter();
  const shownThreadRef = useThreadRouteRef();
  const threads = useQuietThreadShells();
  const runMove = useAtomCommand(terminalEnvironment.move, "terminal move");
  const targets = dropdownTerminalMoveTargets({
    environmentId: input.dropdownRef.environmentId,
    shownThreadRef,
    threads,
  });
  const move = useStableCallback(async (terminalId: string, optionId: string | null) => {
    const target = targets.find((entry) => scopedThreadKey(entry.threadRef) === optionId);
    if (
      !target ||
      target.reason !== null ||
      !readEnvironmentScope(input.dropdownRef.environmentId, AuthTerminalOperateScope)
    )
      return;
    const movedId = await moveTerminalTab({
      from: input.dropdownRef,
      terminalId,
      to: { threadRef: target.threadRef, worktreePath: target.worktreePath },
      move: runMove,
    });
    if (movedId === null) return;
    if (target.shown) {
      focusTerminal(target.threadRef, movedId);
      return;
    }
    focusTerminalOnNavigation(target.threadRef, movedId);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(target.threadRef),
    });
  });
  return (terminalId) => ({
    label: "Move to thread",
    options: targets.map((target) => ({
      id: scopedThreadKey(target.threadRef),
      label: target.title || "Untitled thread",
      detail: target.reason ?? (target.shown ? "Current thread" : null),
      disabled: target.reason !== null,
    })),
    disabledReason: !readEnvironmentScope(input.dropdownRef.environmentId, AuthTerminalOperateScope)
      ? "You can't operate terminals on this machine"
      : targets.every((target) => target.reason !== null)
        ? `No threads on ${input.machine}`
        : null,
    onMove: (optionId) => void move(terminalId, optionId),
  });
}

/** A thread's terminals can move into its machine's drop-down. */
export function useMoveToDropdownMenu(
  threadRef: ScopedThreadRef | null,
): ((terminalId: string) => TerminalMoveMenu) | null {
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const runMove = useAtomCommand(terminalEnvironment.move, "terminal move");
  const move = useStableCallback(async (terminalId: string) => {
    if (!threadRef) return;
    const entry = readEnvironment(threadRef.environmentId);
    if (
      !entry ||
      availableScratchWorkspaceRoot(entry.connection.phase, entry.serverConfig) === null ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    )
      return;
    await moveTerminalToDropdown({
      from: threadRef,
      terminalId,
      target: dropdownTerminalTarget(entry, readPrimaryEnvironmentId(), isElectron),
      move: runMove,
    });
  });
  if (!threadRef) return null;
  const disabledReason =
    environment?.connection.phase !== "connected"
      ? "This machine is disconnected"
      : availableScratchWorkspaceRoot(environment.connection.phase, environment.serverConfig) ===
          null
        ? "This machine has no default folder"
        : !canOperate
          ? "You can't operate terminals on this machine"
          : null;
  return (terminalId) => ({
    label: "Move to drop-down",
    options: null,
    disabledReason,
    onMove: () => void move(terminalId),
  });
}
