import type {
  ThreadQuestion,
  ThreadWorkspace,
  WaitingCounts,
  WaitingItemSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  closedQuestionOutcome,
  createQuestionDraftSaver,
  createQuestionDraftSavers,
  questionAfterSave,
  questionRefreshKey,
  workspaceQuestionRows,
  toggleQuestionOption,
  type QuestionDraft,
} from "./questionCard.logic";

const options = [
  { id: "a", label: "Alpha", description: "" },
  { id: "b", label: "Beta", description: "" },
  { id: "c", label: "Gamma", description: "" },
];

const question = (overrides: Partial<ThreadQuestion> = {}): ThreadQuestion => ({
  id: "Q1",
  prompt: "Pick one",
  options,
  recommendedOptionIds: [],
  multiSelect: false,
  state: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
  answer: null,
  answeredBy: null,
  replacedBy: null,
  ...overrides,
});

const workspace = (revision: number, questions: ThreadQuestion[]) =>
  ({ revision, questions }) as unknown as ThreadWorkspace;

describe("toggleQuestionOption", () => {
  it.each([
    { multiSelect: false, chosen: [], tap: "b", next: ["b"] },
    { multiSelect: false, chosen: ["a"], tap: "b", next: ["b"] },
    { multiSelect: false, chosen: ["b"], tap: "b", next: [] },
    { multiSelect: true, chosen: ["c"], tap: "a", next: ["a", "c"] },
    { multiSelect: true, chosen: ["a", "c"], tap: "a", next: ["c"] },
  ])("multiSelect $multiSelect, $chosen tapped $tap gives $next", (row) => {
    expect(
      toggleQuestionOption({ options, multiSelect: row.multiSelect }, row.chosen, row.tap),
    ).toEqual(row.next);
  });
});

describe("closedQuestionOutcome", () => {
  it.each([
    { state: "open" as const, answer: null, replacedBy: null, outcome: null },
    { state: "deferred" as const, answer: null, replacedBy: null, outcome: null },
    {
      state: "answered" as const,
      answer: { chosenOptionIds: ["c", "a"], notes: " soon ", submittedAt: "2026-01-02T00:00:00Z" },
      replacedBy: null,
      outcome: "Alpha, Gamma · “soon”",
    },
    {
      state: "answered" as const,
      answer: { chosenOptionIds: [], notes: "", submittedAt: "2026-01-02T00:00:00Z" },
      replacedBy: null,
      outcome: "Answered",
    },
    { state: "withdrawn" as const, answer: null, replacedBy: null, outcome: "Dismissed" },
    { state: "replaced" as const, answer: null, replacedBy: "Q4", outcome: "Replaced by Q4" },
  ])("$state reads $outcome", ({ outcome, ...fields }) => {
    expect(closedQuestionOutcome(question(fields))).toBe(outcome);
  });
});

describe("questionRefreshKey", () => {
  const run = { runId: "run-1", completedAt: null };
  const counts: WaitingCounts = { question: 1, qa: 1, task: 0, liveQuestions: 1 };
  const row = (key: string, extra: Partial<WaitingItemSummary> = {}): WaitingItemSummary => ({
    kind: "question",
    ref: key,
    key,
    title: `Question ${key}`,
    state: "open",
    ...extra,
  });
  const qaRow: WaitingItemSummary = {
    kind: "qa",
    ref: "QA1",
    key: "l/c",
    title: "x",
    state: "open",
  };
  const key = questionRefreshKey(run, [row("Q1"), qaRow], counts);

  it("changes when one open question replaces another though the counts stay equal", () => {
    expect(questionRefreshKey(run, [row("Q2"), qaRow], counts)).not.toBe(key);
  });

  it("changes when a deferred question with a queued answer reopens though the counts stay equal", () => {
    const queued = { ...counts, question: 0 };
    expect(questionRefreshKey(run, [row("Q1", { state: "open", sent: true })], queued)).not.toBe(
      questionRefreshKey(run, [row("Q1", { state: "deferred", sent: true })], queued),
    );
  });

  it.each([
    {
      change: "a question dismissed",
      next: () => questionRefreshKey(run, [qaRow], { ...counts, question: 0, liveQuestions: 0 }),
    },
    {
      change: "the run ending",
      next: () =>
        questionRefreshKey(
          { ...run, completedAt: "2026-01-01T00:00:00Z" },
          [row("Q1"), qaRow],
          counts,
        ),
    },
  ])("changes on $change", ({ next }) => {
    expect(next()).not.toBe(key);
  });

  it("ignores QA rows and QA and task counts", () => {
    expect(
      questionRefreshKey(run, [row("Q1"), { ...qaRow, state: "settled" }], {
        ...counts,
        qa: 4,
        task: 2,
      }),
    ).toBe(key);
  });
});

describe("workspaceQuestionRows", () => {
  it("lists open and deferred questions as the server does, and leaves closed ones out", () => {
    expect(
      workspaceQuestionRows([
        question({ id: "Q1", prompt: "Pick one" }),
        question({ id: "Q2", state: "deferred", sentInMessageId: "m1" as never }),
        question({ id: "Q3", state: "deferred", discussedInMessageId: "m2" as never }),
        question({ id: "Q4", state: "answered" }),
      ]),
    ).toEqual([
      { kind: "question", ref: "Q1", key: "Q1", title: "Pick one", state: "open" },
      { kind: "question", ref: "Q2", key: "Q2", title: "Pick one", state: "deferred", sent: true },
      {
        kind: "question",
        ref: "Q3",
        key: "Q3",
        title: "Pick one",
        state: "discussing",
        deferred: true,
      },
    ]);
  });
});

describe("questionAfterSave", () => {
  const shown = question({ prompt: "Shown" });
  it("uses the saved question only when its workspace is newer than the one shown", () => {
    const saved = question({ prompt: "Saved" });
    expect(questionAfterSave(shown, 4, { saved: workspace(5, [saved]) })).toBe(saved);
    expect(questionAfterSave(shown, 5, { saved: workspace(5, [saved]) })).toBe(shown);
    expect(questionAfterSave(shown, 4, { saved: null })).toBe(shown);
  });
  it("is null when the last save failed", () => {
    expect(questionAfterSave(shown, 4, null)).toBeNull();
  });
});

const manualTimers = () => {
  const queue: Array<() => void> = [];
  return {
    timers: {
      set: (run: () => void) => {
        queue.push(run);
        return queue.length as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (timer: ReturnType<typeof setTimeout>) => {
        queue[(timer as unknown as number) - 1] = () => {};
      },
    },
    fire: () => queue.splice(0).forEach((run) => run()),
  };
};
const base: QuestionDraft = { chosenOptionIds: [], notes: "" };

describe("createQuestionDraftSaver", () => {
  it("sends a waiting note together with a later choice, in one write", async () => {
    const writes: QuestionDraft[] = [];
    const saver = createQuestionDraftSaver<number>(
      async (draft) => (writes.push(draft), writes.length),
      { timers: manualTimers().timers },
    );
    const note = saver.edit(base, { notes: "because" }, 600);
    const choice = saver.edit(base, { chosenOptionIds: ["a"] });
    expect(await Promise.all([note, choice])).toEqual([true, true]);
    expect(writes).toEqual([{ chosenOptionIds: ["a"], notes: "because" }]);
  });

  it("flush sends a waiting note and reports the newest save", async () => {
    const writes: QuestionDraft[] = [];
    const saver = createQuestionDraftSaver<number>(async (draft) => (writes.push(draft), 7), {
      timers: manualTimers().timers,
    });
    void saver.edit(base, { notes: "draft" }, 600);
    expect(saver.pending()).toEqual({ chosenOptionIds: [], notes: "draft" });
    expect(await saver.flush()).toEqual({ saved: 7 });
    expect(writes).toEqual([{ chosenOptionIds: [], notes: "draft" }]);
    expect(saver.pending()).toBeNull();
  });

  it("keeps a failed write's values and sends them again on the next flush", async () => {
    const writes: QuestionDraft[] = [];
    let online = false;
    const saver = createQuestionDraftSaver<number>(
      async (draft) => {
        writes.push(draft);
        return online ? 9 : null;
      },
      { timers: manualTimers().timers },
    );
    expect(await saver.edit(base, { chosenOptionIds: ["b"], notes: "why" })).toBe(false);
    expect(saver.pending()).toEqual({ chosenOptionIds: ["b"], notes: "why" });
    expect(await saver.flush()).toBeNull();
    online = true;
    expect(await saver.flush()).toEqual({ saved: 9 });
    expect(writes).toEqual([
      { chosenOptionIds: ["b"], notes: "why" },
      { chosenOptionIds: ["b"], notes: "why" },
      { chosenOptionIds: ["b"], notes: "why" },
    ]);
    expect(saver.pending()).toBeNull();
  });

  it("keeps a newer saved edit when an older write fails after it was sent", async () => {
    const writes: QuestionDraft[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const saver = createQuestionDraftSaver<number>(
      async (draft) => {
        writes.push(draft);
        if (writes.length === 1) {
          await firstGate;
          return null;
        }
        return writes.length;
      },
      { timers: manualTimers().timers },
    );
    const first = saver.edit(base, { chosenOptionIds: ["a"] });
    const second = saver.edit(base, { notes: "newer" });
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([false, true]);
    expect(saver.pending()).toBeNull();
    expect(await saver.flush()).toEqual({ saved: null });
    expect(writes).toEqual([
      { chosenOptionIds: ["a"], notes: "" },
      { chosenOptionIds: ["a"], notes: "newer" },
    ]);
  });

  it("merges an edit made while a save is in flight over the values in flight", async () => {
    const writes: QuestionDraft[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const saver = createQuestionDraftSaver<number>(
      async (draft) => {
        writes.push(draft);
        if (writes.length === 1) await gate;
        return writes.length;
      },
      { timers: manualTimers().timers },
    );
    const first = saver.edit(base, { chosenOptionIds: ["a"] });
    const second = saver.edit(base, { notes: "and why" });
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual([
      { chosenOptionIds: ["a"], notes: "" },
      { chosenOptionIds: ["a"], notes: "and why" },
    ]);
  });
});

describe("createQuestionDraftSavers", () => {
  const setup = () => {
    const writes: QuestionDraft[] = [];
    let created = 0;
    let gate: Promise<void> | null = null;
    const savers = createQuestionDraftSavers<string, ThreadWorkspace>(
      (key) => key,
      () => {
        created += 1;
        return async (draft) => {
          writes.push(draft);
          await gate;
          return workspace(writes.length, []);
        };
      },
      manualTimers().timers,
    );
    const hold = (gated: boolean) => {
      let open: () => void = () => {};
      gate = gated ? new Promise<void>((resolve) => (open = resolve)) : null;
      return () => open();
    };
    return { savers, writes, created: () => created, hold };
  };

  it("carries a note queued after a remount across a settling write into the next flush", async () => {
    const { savers, writes, hold } = setup();
    const releaseFirst = savers.hold("Q1");
    const settle = hold(true);
    const choice = savers.draft("Q1").edit(base, { chosenOptionIds: ["a"] });
    releaseFirst();
    // The remounted card renders before its hold, and the write settles in between.
    const remounted = savers.draft("Q1");
    expect(remounted.pending()).toEqual({ chosenOptionIds: ["a"], notes: "" });
    hold(false);
    settle();
    await choice;
    const releaseSecond = savers.hold("Q1");
    void remounted.edit({ chosenOptionIds: ["a"], notes: "" }, { notes: "queued" }, 600);
    expect(await savers.draft("Q1").flush()).not.toBeNull();
    expect(writes).toEqual([
      { chosenOptionIds: ["a"], notes: "" },
      { chosenOptionIds: ["a"], notes: "queued" },
    ]);
    releaseSecond();
  });

  it("reports a failed flush as null, and an idle question as nothing saved", async () => {
    const savers = createQuestionDraftSavers<string, number>(
      (key) => key,
      () => async () => null,
      manualTimers().timers,
    );
    expect(await savers.draft("Q1").flush()).toEqual({ saved: null });
    const release = savers.hold("Q1");
    void savers.draft("Q1").edit(base, { notes: "unsaved" }, 600);
    expect(await savers.draft("Q1").flush()).toBeNull();
    release();
  });

  it("shares one saver while one card replaces another, as a question moves section", async () => {
    const { savers, writes, created } = setup();
    const releaseWaiting = savers.hold("Q1");
    void savers.draft("Q1").edit(base, { notes: "half typed" }, 600);
    const releaseDeferred = savers.hold("Q1");
    releaseWaiting();
    void savers.draft("Q1").edit(base, { chosenOptionIds: ["b"] }, 600);
    await savers.draft("Q1").flush();
    expect(writes).toEqual([{ chosenOptionIds: ["b"], notes: "half typed" }]);
    expect(created()).toBe(1);
    releaseDeferred();
  });

  it("drops an idle saver once unheld, keeps one with a waiting write until it finishes", async () => {
    const { savers, created } = setup();
    const release = savers.hold("Q1");
    await savers.draft("Q1").edit(base, { notes: "saved" });
    // Idle: the finished write's workspace is not kept for a later flush.
    expect(await savers.draft("Q1").flush()).toEqual({ saved: null });
    release();
    expect(savers.draft("Q1").pending()).toBeNull();

    const waiting = savers.draft("Q2").edit(base, { notes: "typed then closed" }, 600);
    expect(savers.draft("Q2").pending()).toEqual({
      chosenOptionIds: [],
      notes: "typed then closed",
    });
    await savers.draft("Q2").flush();
    await waiting;
    void savers.draft("Q2").edit(base, { notes: "again" }, 600);
    // Q1 once, Q2 twice: the finished, unheld Q2 saver was dropped and made again.
    expect(created()).toBe(3);
  });
});
