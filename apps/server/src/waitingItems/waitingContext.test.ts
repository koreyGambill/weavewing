import { MessageId, type ListItem, type ThreadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { QaForTurn } from "../evidence/EvidenceService.ts";
import { waitingContextInput } from "./waitingContext.ts";

const question = (id: string, patch: Partial<ThreadQuestion> = {}): ThreadQuestion => ({
  id,
  prompt: `Question ${id}?`,
  options: [],
  recommendedOptionIds: [],
  multiSelect: false,
  state: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
  answer: null,
  answeredBy: null,
  replacedBy: null,
  ...patch,
});
const task = (ref: string, patch: Partial<ListItem> = {}): ListItem => ({
  id: `task-${ref}`,
  text: `Task ${ref}`,
  state: "open",
  owner: "you",
  createdAt: "2026-01-01T00:00:00.000Z",
  doneAt: null,
  details: "",
  parentId: null,
  links: [],
  ref,
  ...patch,
});
const qa = (ref: string, patch: Partial<QaForTurn> = {}): QaForTurn => ({
  ref,
  title: `Change ${ref}`,
  state: "pending",
  note: "",
  by: "server",
  discussed: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});
const before = "2026-01-02T00:00:00.000Z";
const after = "2026-01-03T00:00:00.000Z";

describe("waitingContextInput", () => {
  it("lists every waiting kind on a user's turn, with discussing and sent marks", () => {
    const input = waitingContextInput({
      questions: [
        question("Q1"),
        question("Q2", { state: "deferred", discussedInMessageId: MessageId.make("m") }),
        question("Q3", { sentInMessageId: MessageId.make("m") }),
        question("Q4", { state: "answered" }),
      ],
      tasks: [
        task("T1", { discussedInMessageId: MessageId.make("m") }),
        task("T2", { state: "done" }),
        task("T3", { owner: "agent" }),
      ],
      qa: [qa("QA1"), qa("QA2", { discussed: true }), qa("QA3", { state: "problem", note: "x" })],
      userTurn: true,
      sinceMs: Date.parse(before),
    });
    expect(input.waiting).toEqual([
      { kind: "question", ref: "Q1", title: "Question Q1?", state: "open" },
      { kind: "question", ref: "Q2", title: "Question Q2?", state: "discussing", deferred: true },
      { kind: "question", ref: "Q3", title: "Question Q3?", state: "open", sent: true },
      { kind: "qa", ref: "QA1", title: "Change QA1", state: "open" },
      { kind: "qa", ref: "QA2", title: "Change QA2", state: "discussing" },
      { kind: "task", ref: "T1", title: "Task T1", state: "discussing" },
    ]);
    expect(input.problems).toEqual([{ ref: "QA3", title: "Change QA3", note: "x" }]);
  });

  it("names only what the user changed after their previous message", () => {
    const input = waitingContextInput({
      questions: [
        question("Q1", { state: "withdrawn", userChangedAt: after }),
        question("Q2", { state: "deferred", userChangedAt: before }),
      ],
      tasks: [
        task("T1", { state: "done", settledBy: "user", userChangedAt: after }),
        task("T2", { state: "dropped", settledBy: "user", userChangedAt: after }),
        task("T3", { state: "done", settledBy: "agent" }),
      ],
      qa: [
        qa("QA1", { state: "confirmed", by: "user", updatedAt: after }),
        qa("QA2", { state: "waived", by: "user", updatedAt: after }),
        qa("QA3", { state: "confirmed", by: "agent", updatedAt: after }),
        qa("QA4", { state: "pending", by: "user", updatedAt: after }),
      ],
      userTurn: true,
      sinceMs: Date.parse(before),
    });
    expect(input.changes.map(({ ref, change }) => `${change} ${ref}`)).toEqual([
      "withdrew Q1",
      "confirmed QA1",
      "dismissed QA2",
      "reopened QA4",
      "done T1",
      "cancelled T2",
    ]);
  });

  it("gives a turn without the user's message only the QA problems", () => {
    const input = waitingContextInput({
      questions: [question("Q1", { state: "withdrawn", userChangedAt: after })],
      tasks: [task("T1")],
      qa: [qa("QA1"), qa("QA2", { state: "problem", note: "still overlaps" })],
      userTurn: false,
      sinceMs: null,
    });
    expect(input).toEqual({
      waiting: [],
      changes: [],
      problems: [{ ref: "QA2", title: "Change QA2", note: "still overlaps" }],
    });
  });

  it("leaves out each kind the session has no tools for", () => {
    const input = waitingContextInput({
      questions: [question("Q1")],
      tasks: [task("T1")],
      qa: [qa("QA1"), qa("QA2", { state: "problem", note: "x" })],
      userTurn: true,
      sinceMs: null,
      available: { questions: false, lists: true },
    });
    expect(input.waiting.map((item) => item.ref)).toEqual(["QA1", "T1"]);
    expect(input.problems.map((problem) => problem.ref)).toEqual(["QA2"]);
    const noLists = waitingContextInput({
      questions: [question("Q1")],
      tasks: [task("T1")],
      qa: [qa("QA2", { state: "problem", note: "x" })],
      userTurn: true,
      sinceMs: null,
      available: { questions: true, lists: false },
    });
    expect(noLists.waiting.map((item) => item.ref)).toEqual(["Q1"]);
    expect(noLists.problems).toEqual([]);
  });
});
