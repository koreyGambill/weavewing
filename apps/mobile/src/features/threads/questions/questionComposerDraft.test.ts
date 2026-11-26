import {
  syncComposerQuestionAnswers,
  threadQuestionAnswerRecord,
  threadQuestionDiscussRecord,
  withComposerQuestionAnswer,
  withoutComposerQuestionAnswer,
} from "@t3tools/client-runtime/state/thread-questions";
import {
  ComposerContextId,
  type ComposerContextRecord,
  type ThreadQuestion,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { referencedComposerContext } from "../../../lib/composerContext";
import { composerQuestionRecords, withComposerQuestionRecords } from "./questionComposerDraft";

const question = (overrides: Partial<ThreadQuestion> = {}): ThreadQuestion => ({
  id: "Q1",
  prompt: "Which database should the cache use?",
  options: [
    { id: "sqlite", label: "SQLite", description: "One file" },
    { id: "redis", label: "Redis", description: "A server" },
  ],
  recommendedOptionIds: ["sqlite"],
  multiSelect: false,
  state: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
  answer: { chosenOptionIds: ["sqlite"], notes: "", submittedAt: null, draftRevision: 3 },
  answeredBy: null,
  replacedBy: null,
  ...overrides,
});

const answerOf = (overrides: Partial<ThreadQuestion> = {}) =>
  threadQuestionAnswerRecord("thread-1", question(overrides))!;

const mention: ComposerContextRecord = {
  version: 1,
  kind: "mention",
  contextId: ComposerContextId.make("mention_1"),
  label: "README.md",
  path: "README.md",
};

describe("withComposerQuestionRecords", () => {
  it("references a new answer at the end of the text and keeps other context", () => {
    const draft = {
      text: `Look at ${formatComposerContextReference(mention)}`,
      context: { version: 1 as const, records: [mention] },
    };
    const record = answerOf();
    const next = withComposerQuestionRecords(draft, [record])!;
    expect(next.text).toBe(`${draft.text} ${formatComposerContextReference(record)} `);
    expect(next.context?.records).toEqual([mention, record]);
    // Every record stays referenced, so the draft store's reference filter keeps them all.
    expect(referencedComposerContext(next.text, next.context)).toEqual(next.context);
  });

  it("replaces a newer draft in place without a second reference", () => {
    const first = withComposerQuestionRecords({ text: "" }, [answerOf()])!;
    const newer = answerOf({
      answer: { chosenOptionIds: ["redis"], notes: "", submittedAt: null, draftRevision: 4 },
    });
    const next = withComposerQuestionRecords(first, [newer])!;
    expect(next.text).toBe(first.text);
    expect(composerQuestionRecords(next.context)).toEqual([newer]);
    expect(composerQuestionRecords(next.context)[0]?.choice).toBe("Redis");
  });

  it("removes a record's reference and the space beside it", () => {
    const record = answerOf();
    const draft = {
      text: `Before ${formatComposerContextReference(record)} after`,
      context: { version: 1 as const, records: [record] },
    };
    const next = withComposerQuestionRecords(draft, [])!;
    expect(next.text).toBe("Before after");
    expect(next.context).toBeUndefined();
  });

  it("swaps an answer for a discussion of the same question", () => {
    const answered = withComposerQuestionRecords({ text: "" }, [answerOf()])!;
    const discuss = threadQuestionDiscussRecord(
      "thread-1",
      question({
        answer: { chosenOptionIds: [], notes: "Why not Redis?", submittedAt: null },
      }),
    )!;
    const next = withComposerQuestionRecords(
      answered,
      withComposerQuestionAnswer(composerQuestionRecords(answered.context), discuss),
    )!;
    expect(next.text).toBe(`${formatComposerContextReference(discuss)} `);
    expect(composerQuestionRecords(next.context)).toEqual([discuss]);
  });

  it("returns null when the records are unchanged", () => {
    const draft = withComposerQuestionRecords({ text: "Hi" }, [answerOf()])!;
    expect(withComposerQuestionRecords(draft, composerQuestionRecords(draft.context))).toBeNull();
    expect(
      withComposerQuestionRecords(
        draft,
        withoutComposerQuestionAnswer(composerQuestionRecords(draft.context), "Q9"),
      ),
    ).toBeNull();
  });

  it("drops the chip of a question that closed since it was added", () => {
    const draft = withComposerQuestionRecords({ text: "Thanks" }, [answerOf()])!;
    const synced = syncComposerQuestionAnswers("thread-1", composerQuestionRecords(draft.context), {
      revision: 5,
      questions: [question({ state: "withdrawn", closedAt: "2026-01-02T00:00:00Z" })],
    });
    expect(synced).toEqual([]);
    const next = withComposerQuestionRecords(draft, synced!)!;
    expect(next.text).toBe("Thanks");
    expect(next.context).toBeUndefined();
  });
});
