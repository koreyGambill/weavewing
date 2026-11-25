import { describe, expect, it } from "vite-plus/test";

import { createQuestionDraftWriter, type QuestionDraft } from "./questionDraftWriter";

// Timers the test fires by hand, so ordering never depends on the clock.
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    set: (run: () => void) => {
      next += 1;
      pending.set(next, run);
      return next as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (timer: ReturnType<typeof setTimeout>) =>
      void pending.delete(timer as unknown as number),
    fireAll: () => {
      const runs = [...pending.values()];
      pending.clear();
      for (const run of runs) run();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Records each save. A gated question's save waits until the test releases it.
function recordingSave(gated: ReadonlySet<string> = new Set()) {
  const sent: Array<[string, QuestionDraft]> = [];
  const started = new Map<string, ReturnType<typeof deferred>>();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const startedOf = (id: string) => started.get(id) ?? started.set(id, deferred()).get(id)!;
  const gateOf = (id: string) => gates.get(id) ?? gates.set(id, deferred()).get(id)!;
  const save = async (id: string, draft: QuestionDraft) => {
    sent.push([id, draft]);
    startedOf(id).resolve();
    if (gated.has(id)) await gateOf(id).promise;
    return sent.length;
  };
  return { sent, save, started: startedOf, release: (id: string) => gateOf(id).resolve() };
}

const saved: QuestionDraft = { chosenOptionIds: ["a"], notes: "" };

describe("question draft writer", () => {
  it("keeps a note whose save is in flight when a choice follows", async () => {
    const writer = createQuestionDraftWriter<number>(manualTimers());
    const { sent, save, started, release } = recordingSave(new Set(["Q1"]));

    void writer.edit("Q1", saved, { notes: "soon" }, save, 600);
    void writer.flush("Q1", save);
    await started("Q1").promise;
    void writer.edit("Q1", saved, { chosenOptionIds: ["b"] }, save);
    release("Q1");
    await writer.flushAll(save);

    expect(sent.at(-1)).toEqual(["Q1", { chosenOptionIds: ["b"], notes: "soon" }]);
  });

  it("sends a choice made while a note waits with both, and never the stale choice", async () => {
    const timers = manualTimers();
    const writer = createQuestionDraftWriter<number>(timers);
    const { sent, save } = recordingSave();

    void writer.edit("Q1", saved, { notes: "soon" }, save, 600);
    void writer.edit("Q1", saved, { chosenOptionIds: ["b"] }, save);
    timers.fireAll();
    await writer.flushAll(save);

    expect(sent).toEqual([["Q1", { chosenOptionIds: ["b"], notes: "soon" }]]);
  });

  it("sends a waiting note and waits for writes in flight before Send submits", async () => {
    const writer = createQuestionDraftWriter<number>(manualTimers());
    const { sent, save, started, release } = recordingSave(new Set(["Q1"]));

    void writer.edit("Q1", saved, { chosenOptionIds: ["b"] }, save);
    void writer.edit("Q2", saved, { notes: "typed just now" }, save, 600);
    let flushed = false;
    const done = writer.flushAll(save).then((result) => {
      flushed = true;
      return result;
    });
    await started("Q2").promise;
    expect(sent[1]).toEqual(["Q2", { chosenOptionIds: ["a"], notes: "typed just now" }]);
    expect(flushed).toBe(false);
    release("Q1");
    expect(await done).toBe(2);
  });

  it("starts a question's next write only after the previous one settled", async () => {
    const writer = createQuestionDraftWriter<number>(manualTimers());
    const { sent, save, started, release } = recordingSave(new Set(["Q1"]));

    void writer.edit("Q1", saved, { chosenOptionIds: ["b"] }, save);
    void writer.edit("Q1", saved, { chosenOptionIds: ["c"] }, save);
    await started("Q1").promise;
    expect(sent).toHaveLength(1);
    release("Q1");
    await writer.flushAll(save);
    expect(sent.map(([, draft]) => draft.chosenOptionIds)).toEqual([["b"], ["c"]]);
  });
});
