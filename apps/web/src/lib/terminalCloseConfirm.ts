import type { ScopedThreadRef } from "@t3tools/contracts";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { knownTerminalSessionsAtom } from "~/state/terminalSessions";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmTerminalClose(
  threadRef: ScopedThreadRef,
  terminals: ReadonlyArray<{ readonly terminalId: string; readonly label: string }>,
): Promise<boolean> {
  const sessions = appAtomRegistry.get(
    knownTerminalSessionsAtom(threadRef.environmentId, threadRef.threadId),
  );
  const runningTerminalIds = new Set(
    sessions
      ?.filter((session) => session.state.hasRunningSubprocess)
      .map((session) => session.target.terminalId),
  );
  const labels = terminals
    .filter((terminal) => runningTerminalIds.has(terminal.terminalId))
    .map((terminal) => terminal.label);
  if (labels.length === 0) return true;
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            `Close terminal "${labels[0]}"?`,
            "This stops the running process and clears its history.",
          ].join("\n")
        : [
            `Close ${labels.length} terminals?`,
            `This stops their running processes and clears their histories: ${labels
              .map((label) => `"${label}"`)
              .join(", ")}.`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
