import type { ThreadWorkspace } from "@t3tools/contracts";

export interface QuestionDraft {
  readonly chosenOptionIds: ReadonlyArray<string>;
  readonly notes: string;
}

/** Saves one question's draft; resolves with whatever the save returned, or null on failure. */
export type SaveQuestionDraft<R> = (id: string, draft: QuestionDraft) => Promise<R | null>;

interface Entry<R> {
  latest: QuestionDraft | null;
  // The newest values handed to a save. Callers' `saved` lags until that save returns.
  sent: QuestionDraft | null;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<R | null>;
  waiters: Array<() => void>;
}

/**
 * Orders one thread's draft writes. An edit merges into the newest unsent values for its
 * question, so a note waiting on its delay and a later choice go out together, and each
 * question's writes run one after another. `flushAll` sends what is waiting and resolves once
 * every write has settled, with the last save's result.
 */
export function createQuestionDraftWriter<R>(
  timers: {
    readonly set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
    readonly clear: (timer: ReturnType<typeof setTimeout>) => void;
  } = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) },
) {
  const entries = new Map<string, Entry<R>>();
  let lastResult: R | null = null;
  const entryOf = (id: string): Entry<R> => {
    let entry = entries.get(id);
    if (entry === undefined) {
      entry = { latest: null, sent: null, timer: null, chain: Promise.resolve(null), waiters: [] };
      entries.set(id, entry);
    }
    return entry;
  };
  const flush = (id: string, save: SaveQuestionDraft<R>) => {
    const entry = entryOf(id);
    if (entry.timer !== null) {
      timers.clear(entry.timer);
      entry.timer = null;
    }
    const draft = entry.latest;
    if (draft === null) return entry.chain;
    const waiters = entry.waiters;
    entry.latest = null;
    entry.sent = draft;
    entry.waiters = [];
    entry.chain = entry.chain.then(async () => {
      const result = await save(id, draft);
      if (entry.sent === draft) entry.sent = null;
      if (result !== null) lastResult = result;
      for (const resolve of waiters) resolve();
      return result;
    });
    return entry.chain;
  };
  return {
    /**
     * Applies `change` over the newest values (or `saved` when nothing is waiting) and sends
     * them now, or after `delayMs`. Resolves once the write carrying this change settled.
     */
    edit(
      id: string,
      saved: QuestionDraft,
      change: Partial<QuestionDraft>,
      save: SaveQuestionDraft<R>,
      delayMs = 0,
    ): Promise<void> {
      const entry = entryOf(id);
      entry.latest = { ...(entry.latest ?? entry.sent ?? saved), ...change };
      const done = new Promise<void>((resolve) => entry.waiters.push(resolve));
      if (entry.timer !== null) timers.clear(entry.timer);
      entry.timer = null;
      if (delayMs > 0) entry.timer = timers.set(() => void flush(id, save), delayMs);
      else void flush(id, save);
      return done;
    },
    flush: (id: string, save: SaveQuestionDraft<R>) => flush(id, save).then(() => undefined),
    /** Sends every waiting draft and resolves after all writes, with the newest save result. */
    async flushAll(save: SaveQuestionDraft<R>): Promise<R | null> {
      await Promise.all([...entries.keys()].map((id) => flush(id, save)));
      return lastResult;
    },
  };
}

const writers = new Map<string, ReturnType<typeof createQuestionDraftWriter<ThreadWorkspace>>>();

/** The writer every card and panel of one thread shares, so Send sees the cards' edits. */
export function questionDraftWriter(threadKey: string) {
  let writer = writers.get(threadKey);
  if (writer === undefined) {
    writer = createQuestionDraftWriter<ThreadWorkspace>();
    writers.set(threadKey, writer);
  }
  return writer;
}
