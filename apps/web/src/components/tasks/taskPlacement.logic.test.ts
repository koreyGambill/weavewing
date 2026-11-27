import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { withUnplacedTaskCards } from "./taskPlacement.logic";

const CREATED_AT = "2026-11-25T10:00:00.000Z";
const tasks = (id: string, taskRefs: ReadonlyArray<string>) =>
  ({ id, kind: "thread-tasks", createdAt: CREATED_AT, runId: null, taskRefs }) as TimelineEntry;
const work = (id: string, deferred: boolean) =>
  ({
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: {
      id,
      createdAt: CREATED_AT,
      projectedItem: { item: deferred ? { deferredWork: { cursor: "c", lastOrdinal: 9 } } : {} },
    },
  }) as unknown as TimelineEntry;

describe("withUnplacedTaskCards", () => {
  it("puts tasks whose filing is folded away at the loaded start", () => {
    const entries = [work("folded", true), tasks("filed", ["T1"])];
    expect(withUnplacedTaskCards(entries, ["T1", "T2", "T3"], true)).toEqual([
      {
        id: "tasks:start",
        kind: "thread-tasks",
        createdAt: CREATED_AT,
        runId: null,
        taskRefs: ["T2", "T3"],
      },
      ...entries,
    ]);
  });

  it("puts them there while earlier history is not loaded", () => {
    const entries = [work("plain", false)];
    expect(withUnplacedTaskCards(entries, ["T2"], false)[0]).toMatchObject({
      id: "tasks:start",
      taskRefs: ["T2"],
    });
  });

  it("raises no card for a task added in Todos when the whole thread is loaded", () => {
    const entries = [work("plain", false), tasks("filed", ["T1"])];
    expect(withUnplacedTaskCards(entries, ["T1", "T2"], true)).toBe(entries);
    expect(withUnplacedTaskCards(entries, [], false)).toBe(entries);
  });
});
