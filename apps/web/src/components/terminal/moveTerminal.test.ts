import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type TerminalMoveInput,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { dropdownTerminalRef } from "../../dropdownTerminal.logic";
import { useDropdownTerminalStore } from "../../dropdownTerminalStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { moveTerminalTab } from "./moveTerminal";

const environmentId = EnvironmentId.make("env-1");
const dropdown = dropdownTerminalRef(environmentId);
const thread = scopeThreadRef(environmentId, ThreadId.make("thread-A"));

const terminalsIn = (ref: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.flatMap(
    (surface) => (surface.kind === "terminal" ? [surface] : []),
  );

function moveRecorder(result: "success" | "failure", returnedId?: string) {
  const calls: Array<{ input: TerminalMoveInput; sourceTabs: number }> = [];
  const move: Parameters<typeof moveTerminalTab>[0]["move"] = async (target) => {
    const source = scopeThreadRef(environmentId, ThreadId.make(target.input.threadId));
    calls.push({ input: target.input, sourceTabs: terminalsIn(source).length });
    return result === "success"
      ? AsyncResult.success({
          cwd: "/home/user/project",
          terminalId: returnedId ?? target.input.toTerminalId,
        } as TerminalSessionSnapshot)
      : AsyncResult.failure(Cause.fail(new Error("refused")));
  };
  return { calls, move };
}

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("moveTerminalTab", () => {
  it("moves a drop-down tab into a thread and back, closing the source tab before the server moves it", async () => {
    useRightPanelStore
      .getState()
      .openTerminal(dropdown, "term-1", { cwd: "/home/user/project", worktreePath: null });
    useRightPanelStore.getState().openTerminal(thread, "term-1");
    const { calls, move } = moveRecorder("success");

    const intoThread = await moveTerminalTab({
      from: dropdown,
      terminalId: "term-1",
      to: { threadRef: thread, worktreePath: "/worktrees/a" },
      move,
    });

    expect(intoThread).not.toBe("term-1");
    expect(calls[0]).toEqual({
      input: {
        threadId: "dropdown-terminal",
        terminalId: "term-1",
        toThreadId: "thread-A",
        toTerminalId: intoThread,
        worktreePath: "/worktrees/a",
      },
      sourceTabs: 0,
    });
    expect(terminalsIn(dropdown)).toEqual([]);
    expect(terminalsIn(thread).map((surface) => surface.resourceId)).toEqual([
      "term-1",
      intoThread,
    ]);
    expect(terminalsIn(thread)[1]?.launchContext).toEqual({
      cwd: "/home/user/project",
      worktreePath: "/worktrees/a",
    });

    const { calls: returnCalls, move: moveBack } = moveRecorder("success", "fresh-id");
    const backToDropdown = await moveTerminalTab({
      from: thread,
      terminalId: intoThread!,
      to: { threadRef: dropdown, worktreePath: null },
      move: moveBack,
    });

    expect(returnCalls[0]?.input).toMatchObject({
      threadId: "thread-A",
      terminalId: intoThread,
      toThreadId: "dropdown-terminal",
      worktreePath: null,
    });
    expect(returnCalls[0]?.sourceTabs).toBe(1);
    expect(terminalsIn(thread).map((surface) => surface.resourceId)).toEqual(["term-1"]);
    expect(backToDropdown).toBe("fresh-id");
    expect(terminalsIn(dropdown).map((surface) => surface.resourceId)).toEqual([backToDropdown]);
  });

  it("puts the tab back, with the drop-down shown, when the server refuses the move", async () => {
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("HTMLElement", Object);
    using _document = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    const launchContext = { cwd: "/home/user/project", worktreePath: null };
    useRightPanelStore.getState().openTerminal(dropdown, "term-1", launchContext);
    useDropdownTerminalStore.setState({ open: true });
    const { move: refuse } = moveRecorder("failure");

    const moved = await moveTerminalTab({
      from: dropdown,
      terminalId: "term-1",
      to: { threadRef: thread, worktreePath: null },
      // The drop-down hides itself once its last tab leaves, before the server answers.
      move: (target) => {
        useDropdownTerminalStore.setState({ open: false });
        return refuse(target);
      },
    });

    expect(moved).toBeNull();
    expect(useDropdownTerminalStore.getState().open).toBe(true);
    expect(terminalsIn(dropdown)).toEqual([
      expect.objectContaining({ resourceId: "term-1", launchContext }),
    ]);
    expect(terminalsIn(thread)).toEqual([]);
  });

  it("never sends a session to another machine", async () => {
    useRightPanelStore.getState().openTerminal(dropdown, "term-1");
    const { calls, move } = moveRecorder("success");
    const elsewhere = scopeThreadRef(EnvironmentId.make("env-2"), ThreadId.make("thread-B"));

    const moved = await moveTerminalTab({
      from: dropdown,
      terminalId: "term-1",
      to: { threadRef: elsewhere, worktreePath: null },
      move,
    });

    expect(moved).toBeNull();
    expect(calls).toEqual([]);
    expect(terminalsIn(dropdown)).toHaveLength(1);
  });
});
