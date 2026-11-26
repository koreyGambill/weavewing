import { MessageId, type ListItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { NEEDS_USER_MESSAGE } from "../orchestration-v2/currentUserMessage.ts";
import {
  changeUserTask,
  removedOpenTasks,
  SETTLED_FROM_USER_CLOSES,
  TASK_DONE_NEEDS_USER,
  TASK_DROP_NEEDS_NOTE,
  TASK_LEAVES_ONLY_CLOSED,
  TASK_NOT_HANDED_OFF,
} from "./userTasks.ts";

const now = "2026-02-01T00:00:00.000Z";
const message = MessageId.make("message-user");
const task: ListItem = {
  id: "task-1",
  text: "Rotate the staging webhook secret",
  state: "open",
  owner: "you",
  createdAt: "2026-01-01T00:00:00.000Z",
  doneAt: null,
  details: "",
  parentId: null,
  links: [],
  ref: "T1",
};
const agent = { by: "agent", userMessageId: null } as const;
const agentWithMessage = { by: "agent", userMessageId: message } as const;
const user = { by: "user" } as const;

describe("changeUserTask", () => {
  it("refuses an agent marking the user's task done without the user's message", () => {
    expect(changeUserTask(task, { ...task, state: "done" }, { id: task.id }, agent, now)).toBe(
      TASK_DONE_NEEDS_USER,
    );
    expect(
      changeUserTask(
        task,
        { ...task, state: "done" },
        { id: task.id, settledFromUser: true },
        agent,
        now,
      ),
    ).toBe(NEEDS_USER_MESSAGE);
  });

  it("records an agent's close from the user's message with that message and note", () => {
    expect(
      changeUserTask(
        task,
        { ...task, state: "done" },
        { id: task.id, settledFromUser: true, note: " done, rotated it " },
        agentWithMessage,
        now,
      ),
    ).toEqual({
      ...task,
      state: "done",
      settledBy: "agent",
      settledFromMessageId: message,
      note: "done, rotated it",
    });
  });

  it("lets an agent drop a task only with a note saying why", () => {
    const dropped = { ...task, state: "dropped" as const };
    expect(changeUserTask(task, dropped, { id: task.id }, agent, now)).toBe(TASK_DROP_NEEDS_NOTE);
    expect(changeUserTask(task, dropped, { id: task.id, note: "  " }, agent, now)).toBe(
      TASK_DROP_NEEDS_NOTE,
    );
    expect(
      changeUserTask(task, dropped, { id: task.id, note: "the vendor closed it" }, agent, now),
    ).toEqual({ ...dropped, settledBy: "agent", note: "the vendor closed it" });
  });

  it("keeps an open user task from leaving the user's list any other way", () => {
    expect(changeUserTask(task, { ...task, owner: "agent" }, { id: task.id }, agent, now)).toBe(
      TASK_LEAVES_ONLY_CLOSED,
    );
    expect(
      changeUserTask(task, { ...task, state: "handed_off" }, { id: task.id }, agent, now),
    ).toBe(TASK_NOT_HANDED_OFF);
    expect(removedOpenTasks([task], new Set())).toEqual([task]);
    expect(removedOpenTasks([task], new Set([task.id]))).toEqual([]);
  });

  it("treats handing a finished item to the user as closing their task", () => {
    const finished = { ...task, owner: "agent" as const, state: "done" as const };
    expect(changeUserTask(finished, { ...finished, owner: "you" }, {}, agent, now)).toBe(
      TASK_DONE_NEEDS_USER,
    );
  });

  it("refuses settledFromUser on anything but closing a user task", () => {
    expect(
      changeUserTask(task, task, { id: task.id, settledFromUser: true }, agentWithMessage, now),
    ).toBe(SETTLED_FROM_USER_CLOSES);
    const mine = { ...task, owner: "agent" as const };
    expect(
      changeUserTask(
        mine,
        { ...mine, state: "done" },
        { id: task.id, settledFromUser: true },
        agentWithMessage,
        now,
      ),
    ).toBe(SETTLED_FROM_USER_CLOSES);
  });

  it("marks the user's own changes, ends a discussion and clears the agent's record on reopen", () => {
    const discussed = { ...task, discussedInMessageId: message };
    expect(
      changeUserTask(discussed, { ...task, state: "done" }, { id: task.id }, user, now),
    ).toEqual({ ...task, state: "done", settledBy: "user", userChangedAt: now });
    expect(
      changeUserTask(
        discussed,
        { ...task, text: "Rotate both secrets" },
        { id: task.id },
        user,
        now,
      ),
    ).toEqual({ ...task, text: "Rotate both secrets" });
    const settled = { ...task, state: "done" as const, settledBy: "agent" as const, note: "done" };
    expect(changeUserTask(settled, { ...task, state: "open" }, { id: task.id }, user, now)).toEqual(
      {
        ...task,
        userChangedAt: now,
      },
    );
  });

  it("keeps an agent's edit of a discussed task discussing, and ignores the agent's own items", () => {
    const discussed = { ...task, discussedInMessageId: message };
    expect(
      changeUserTask(discussed, { ...task, details: "Staging only" }, { id: task.id }, agent, now),
    ).toEqual({ ...discussed, details: "Staging only" });
    const mine = { ...task, owner: "agent" as const };
    expect(changeUserTask(mine, { ...mine, state: "done" }, { id: task.id }, agent, now)).toEqual({
      ...mine,
      state: "done",
    });
  });
});
