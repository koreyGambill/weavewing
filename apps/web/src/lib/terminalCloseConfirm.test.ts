import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { confirmMock, readLocalApiMock, getSessionsMock } = vi.hoisted(() => {
  const confirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
  const readLocalApiMock = vi.fn<
    () =>
      | {
          dialogs: { confirm: (message: string, options?: unknown) => Promise<boolean> };
        }
      | undefined
  >();
  const getSessionsMock = vi.fn();
  return { confirmMock, readLocalApiMock, getSessionsMock };
});

vi.mock("~/localApi", () => ({
  readLocalApi: () => readLocalApiMock(),
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: getSessionsMock },
}));
vi.mock("~/state/terminalSessions", () => ({
  knownTerminalSessionsAtom: vi.fn(),
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

import { confirmTerminalClose, isTerminalCloseConfirmPending } from "./terminalCloseConfirm";

describe("terminal close confirmation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    getSessionsMock.mockReset();
    getSessionsMock.mockReturnValue([
      { target: { terminalId: "terminal-1" }, state: { hasRunningSubprocess: true } },
    ]);
    readLocalApiMock.mockReset();
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
  });

  it.each([
    { terminalIds: [] },
    { terminalIds: ["terminal-1"] },
    { terminalIds: ["terminal-1", "terminal-2"] },
  ])("skips confirmation for idle terminals %j", async ({ terminalIds }) => {
    getSessionsMock.mockReturnValue(
      terminalIds.map((terminalId) => ({
        target: { terminalId },
        state: { hasRunningSubprocess: false },
      })),
    );
    await expect(
      confirmTerminalClose(threadRef, [
        { terminalId: "terminal-1", label: "Terminal 1" },
        { terminalId: "terminal-2", label: "Terminal 2" },
      ]),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("confirms only running terminals in a mixed close", async () => {
    confirmMock.mockResolvedValue(false);
    await expect(
      confirmTerminalClose(threadRef, [
        { terminalId: "terminal-2", label: "Idle" },
        { terminalId: "terminal-1", label: "Running" },
      ]),
    ).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledWith(
      'Close terminal "Running"?\nThis stops the running process and clears its history.',
      { variant: "destructive", initialFocus: "confirm" },
    );
  });

  it("confirms every terminal when session state is unknown", async () => {
    getSessionsMock.mockReturnValue(null);
    confirmMock.mockResolvedValue(true);
    await confirmTerminalClose(threadRef, [{ terminalId: "terminal-2", label: "Unknown" }]);
    expect(confirmMock).toHaveBeenCalledWith(
      'Close terminal "Unknown"?\nThis stops the running process and clears its history.',
      { variant: "destructive", initialFocus: "confirm" },
    );
  });

  it("lists only running terminals when several are closing", async () => {
    getSessionsMock.mockReturnValue([
      { target: { terminalId: "terminal-1" }, state: { hasRunningSubprocess: true } },
      { target: { terminalId: "terminal-2" }, state: { hasRunningSubprocess: false } },
      { target: { terminalId: "terminal-3" }, state: { hasRunningSubprocess: true } },
    ]);
    confirmMock.mockResolvedValue(true);
    await expect(
      confirmTerminalClose(threadRef, [
        { terminalId: "terminal-1", label: "First" },
        { terminalId: "terminal-2", label: "Idle" },
        { terminalId: "terminal-3", label: "Third" },
      ]),
    ).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      'Close 2 terminals?\nThis stops their running processes and clears their histories: "First", "Third".',
      { variant: "destructive", initialFocus: "confirm" },
    );
  });

  it("clears pending state and resolves false when the dialog rejects", async () => {
    let reject: (reason?: unknown) => void = () => undefined;
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    const confirmation = confirmTerminalClose(threadRef, [
      { terminalId: "terminal-1", label: "Terminal 1" },
    ]);
    expect(isTerminalCloseConfirmPending()).toBe(true);

    reject(new Error("dialog failed"));
    await expect(confirmation).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });
});
