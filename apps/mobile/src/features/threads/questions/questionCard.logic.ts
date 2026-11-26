import type { ThreadQuestionStatus } from "@t3tools/client-runtime/state/thread-questions";
import {
  threadQuestionTitle,
  type ThreadQuestion,
  type ThreadWorkspace,
  type WaitingCounts,
  type WaitingItemSummary,
} from "@t3tools/contracts";

export interface QuestionDraft {
  readonly chosenOptionIds: ReadonlyArray<string>;
  readonly notes: string;
}

/**
 * The choice after tapping `optionId`: a single choice switches to it, or clears when it was
 * already chosen; a multiple choice toggles it and keeps the options' order.
 */
export function toggleQuestionOption(
  question: Pick<ThreadQuestion, "options" | "multiSelect">,
  chosenOptionIds: ReadonlyArray<string>,
  optionId: string,
): ReadonlyArray<string> {
  const chosen = chosenOptionIds.includes(optionId);
  if (!question.multiSelect) return chosen ? [] : [optionId];
  return question.options
    .map((option) => option.id)
    .filter((id) => (id === optionId ? !chosen : chosenOptionIds.includes(id)));
}

/**
 * What a closed question's one line says after its prompt, or null while it is open or deferred
 * and keeps its full card: an answer's chosen labels and note, or the outcome in a word.
 */
export function closedQuestionOutcome(
  question: Pick<ThreadQuestion, "state" | "options" | "answer" | "replacedBy">,
): string | null {
  switch (question.state) {
    case "open":
    case "deferred":
      return null;
    case "answered": {
      const answer = question.answer;
      const choice = question.options
        .filter((option) => answer?.chosenOptionIds.includes(option.id))
        .map((option) => option.label)
        .join(", ");
      const note = answer?.notes.trim() ?? "";
      return [choice, note ? `“${note}”` : ""].filter(Boolean).join(" · ") || "Answered";
    }
    case "withdrawn":
      return "Dismissed";
    case "replaced":
      return question.replacedBy === null ? "Replaced" : `Replaced by ${question.replacedBy}`;
  }
}

export const QUESTION_STATUS_LABELS: Record<ThreadQuestionStatus, string> = {
  open: "Open",
  deferred: "Deferred",
  drafted: "Drafted",
  "in-composer": "In composer",
  "comment-in-composer": "Comment in composer",
  sent: "Sent · waiting for the agent",
  discussing: "Discussing",
  received: "Received by the agent",
  recorded: "Recorded by the agent",
  dismissed: "Dismissed",
  replaced: "Replaced",
};

/**
 * The question to build a composer record from once its draft writes settled: the saved one when
 * its workspace is newer than the one on screen, else the one on screen. Null when a save failed,
 * so nothing the server never stored is queued.
 */
export function questionAfterSave(
  shown: ThreadQuestion,
  shownRevision: number,
  flushed: { readonly saved: ThreadWorkspace | null } | null,
): ThreadQuestion | null {
  if (flushed === null) return null;
  const saved = flushed.saved;
  if (saved === null || saved.revision <= shownRevision) return shown;
  return saved.questions.find((question) => question.id === shown.id) ?? shown;
}

/** Saves one question's whole draft; resolves with the save's result, or null on failure. */
export type SaveQuestionDraft<R> = (draft: QuestionDraft) => Promise<R | null>;

/**
 * Orders one question's draft writes. An edit merges into the newest unsent values, so a note
 * waiting on its delay and a later choice go out together, and writes run one after another.
 * A failed write keeps its values waiting while they are still the newest edit, so the next edit
 * or flush sends them again. `onIdle` runs once nothing waits, is in flight or is kept.
 */
export function createQuestionDraftSaver<R>(
  save: SaveQuestionDraft<R>,
  options: {
    readonly timers?: {
      readonly set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
      readonly clear: (timer: ReturnType<typeof setTimeout>) => void;
    };
    readonly onIdle?: () => void;
  } = {},
) {
  const timers = options.timers ?? {
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
  let latest: QuestionDraft | null = null;
  // The newest values handed to a save, until that save returns.
  let sent: QuestionDraft | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Resolves with the last write's result, or undefined when nothing was written since idle.
  let chain: Promise<R | null | undefined> = Promise.resolve(undefined);
  let waiters: Array<(ok: boolean) => void> = [];

  const idle = () => latest === null && sent === null && timer === null;
  const send = () => {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    const draft = latest;
    if (draft === null) return chain;
    const settled = waiters;
    latest = null;
    sent = draft;
    waiters = [];
    chain = chain.then(async () => {
      const result = await save(draft);
      const newest = sent === draft;
      if (newest) sent = null;
      // A newer edit already carries these values forward, failed or not.
      if (result === null && newest && latest === null) latest = draft;
      for (const resolve of settled) resolve(result !== null);
      if (idle()) {
        // Drop the finished chain so the saver keeps no workspace once idle.
        chain = Promise.resolve(undefined);
        options.onIdle?.();
      }
      return result;
    });
    return chain;
  };

  return {
    /** Values waiting, in flight or kept after a failed write, newer than the saved draft. */
    pending: (): QuestionDraft | null => latest ?? sent,
    idle,
    /**
     * Applies `change` over the newest values (or `base` when none are waiting) and saves them
     * now, or after `delayMs`. Resolves once the write carrying the change settled, with whether
     * it saved.
     */
    edit(base: QuestionDraft, change: Partial<QuestionDraft>, delayMs = 0): Promise<boolean> {
      latest = { ...(latest ?? sent ?? base), ...change };
      const done = new Promise<boolean>((resolve) => waiters.push(resolve));
      if (timer !== null) timers.clear(timer);
      timer = null;
      if (delayMs > 0) timer = timers.set(() => void send(), delayMs);
      else void send();
      return done;
    },
    /**
     * Saves what is waiting now and resolves after every write with the last write's result
     * (null when nothing was written since the saver was idle), or null when it failed.
     */
    async flush(): Promise<{ readonly saved: R | null } | null> {
      const result = await send();
      return result === null ? null : { saved: result ?? null };
    },
  };
}

export type QuestionDraftSaver<R> = ReturnType<typeof createQuestionDraftSaver<R>>;

/**
 * One saver per question, keyed by `keyOf`, shared by every card that shows it and dropped once
 * no card holds the question and it is idle. Only the registry keeps savers: `draft` handles find
 * the live one on each call, so a card never writes to a saver the registry has dropped.
 */
export function createQuestionDraftSavers<T, R>(
  keyOf: (target: T) => string,
  makeSave: (target: T) => SaveQuestionDraft<R>,
  timers?: NonNullable<Parameters<typeof createQuestionDraftSaver<R>>[1]>["timers"],
) {
  const savers = new Map<string, QuestionDraftSaver<R>>();
  const holders = new Map<string, number>();
  const live = (target: T) => {
    const key = keyOf(target);
    const existing = savers.get(key);
    if (existing !== undefined) return existing;
    const saver: QuestionDraftSaver<R> = createQuestionDraftSaver(makeSave(target), {
      ...(timers === undefined ? {} : { timers }),
      onIdle: () => {
        if (!holders.has(key) && savers.get(key) === saver) savers.delete(key);
      },
    });
    savers.set(key, saver);
    return saver;
  };
  return {
    /** The question's draft writes; each call reaches whichever saver is live then. */
    draft: (target: T) => ({
      /** Peeks without creating a saver, so rendering a card leaves nothing behind. */
      pending: (): QuestionDraft | null => savers.get(keyOf(target))?.pending() ?? null,
      edit: (base: QuestionDraft, change: Partial<QuestionDraft>, delayMs?: number) =>
        live(target).edit(base, change, delayMs),
      flush: async (): Promise<{ readonly saved: R | null } | null> => {
        const saver = savers.get(keyOf(target));
        return saver === undefined ? { saved: null } : saver.flush();
      },
    }),
    /** Counts a card showing the question; the returned function lets go. */
    hold(target: T): () => void {
      const key = keyOf(target);
      holders.set(key, (holders.get(key) ?? 0) + 1);
      return () => {
        const count = (holders.get(key) ?? 1) - 1;
        if (count > 0) {
          holders.set(key, count);
          return;
        }
        holders.delete(key);
        if (savers.get(key)?.idle()) savers.delete(key);
      };
    },
  };
}

/**
 * What the thread's questions are refetched on: its latest run starting or ending, its question
 * waiting counts, and its listed question rows' identity, state and flags, so a change that keeps
 * the counts, such as one question replacing another, still refetches. Drafts are in neither, so
 * they refetch on focus.
 */
export function questionRefreshKey(
  latestRun: { readonly runId: string; readonly completedAt: string | null } | null,
  waiting: ReadonlyArray<WaitingItemSummary> | undefined,
  counts: WaitingCounts | undefined,
): string {
  return JSON.stringify([
    latestRun?.runId ?? null,
    latestRun !== null && latestRun.completedAt === null,
    counts?.question ?? null,
    counts?.liveQuestions ?? null,
    (waiting ?? [])
      .filter((row) => row.kind === "question")
      .map((row) => `${row.key}:${row.state}:${row.sent === true}:${row.deferred === true}`),
  ]);
}

/**
 * The thread's open and deferred questions as waiting rows, from its workspace, so a sheet lists
 * every one rather than only those the thread's capped rows hold. Mirrors the server's rows.
 */
export function workspaceQuestionRows(
  questions: ReadonlyArray<ThreadQuestion>,
): ReadonlyArray<WaitingItemSummary> {
  return questions.flatMap((question): ReadonlyArray<WaitingItemSummary> => {
    if (question.state !== "open" && question.state !== "deferred") return [];
    return [
      {
        kind: "question",
        ref: question.id,
        key: question.id,
        title: threadQuestionTitle(question.prompt),
        state: question.discussedInMessageId ? "discussing" : question.state,
        ...(question.sentInMessageId ? { sent: true as const } : {}),
        ...(question.discussedInMessageId && question.state === "deferred"
          ? { deferred: true as const }
          : {}),
        ...(question.userChangedAt ? { userChangedAt: question.userChangedAt } : {}),
      },
    ];
  });
}
