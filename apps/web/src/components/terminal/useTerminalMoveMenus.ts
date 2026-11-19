import { AuthTerminalOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";

import { dropdownTerminalMoveTargets, dropdownTerminalRef } from "../../dropdownTerminal.logic";
import { useDropdownTerminalStore } from "../../dropdownTerminalStore";
import { useDefaultFolder } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { focusTerminal, focusTerminalOnNavigation } from "../../lib/terminalFocus";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShells } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { CONVERSATION_TAB_ID } from "../../threadTileLayout";
import { moveTerminalTab } from "./moveTerminal";

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
    if (!target || target.reason !== null) return;
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

/** "Move to drop-down" for a thread's terminals, when the drop-down runs on the same machine. */
export function useMoveToDropdownMenu(
  threadRef: ScopedThreadRef | null,
): ((terminalId: string) => TerminalMoveMenu) | null {
  const folder = useDefaultFolder();
  const runMove = useAtomCommand(terminalEnvironment.move, "terminal move");
  const move = useStableCallback(async (terminalId: string) => {
    if (!threadRef || !folder || folder.environmentId !== threadRef.environmentId) return;
    const dropdownRef = dropdownTerminalRef(folder.environmentId);
    const movedId = await moveTerminalTab({
      from: threadRef,
      terminalId,
      to: { threadRef: dropdownRef, worktreePath: null },
      move: runMove,
    });
    if (movedId === null) return;
    // An empty drop-down keeps a conversation tab until its first terminal replaces it.
    useRightPanelStore
      .getState()
      .applyTileAction(dropdownRef, { type: "close-tab", tabId: CONVERSATION_TAB_ID });
    const dropdown = useDropdownTerminalStore.getState();
    if (!dropdown.open) dropdown.toggle();
    focusTerminal(dropdownRef, movedId);
  });
  if (!threadRef) return null;
  const disabledReason = !folder
    ? "No connected machine offers a drop-down terminal"
    : folder.environmentId !== threadRef.environmentId
      ? `The drop-down terminal runs on ${folder.machine}`
      : !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
        ? "You can't operate terminals on this machine"
        : null;
  return (terminalId) => ({
    label: "Move to drop-down",
    options: null,
    disabledReason,
    onMove: () => void move(terminalId),
  });
}
