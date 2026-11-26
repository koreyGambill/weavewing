import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { questionDismissalEntries, withQuestionDismissals } from "./questionDismissals.logic";

const entry = (id: string, createdAt: string) =>
  ({ id, kind: "sent-message", createdAt, runId: null, text: id }) as TimelineEntry;

describe("question dismissals in the timeline", () => {
  const question = (
    ref: string,
    title: string,
    state: "open" | "dismissed",
    userChangedAt?: string,
  ) => ({
    kind: "question" as const,
    ref,
    key: ref,
    title,
    state,
    ...(userChangedAt === undefined ? {} : { userChangedAt }),
  });
  const dismissals = questionDismissalEntries([
    question("Q1", "Ship it?", "open", "2026-01-01T00:00:03.000Z"),
    question("Q2", "Old?", "dismissed", "2026-01-01T00:00:00.500Z"),
    question("Q3", "Flag?", "dismissed", "2026-01-01T00:00:02.500Z"),
    question("Q4", "Late?", "dismissed", "2026-01-01T00:00:09.000Z"),
    question("Q5", "Agent's own", "dismissed"),
    // A task the user cancelled is not a question's dismissal.
    {
      kind: "task",
      ref: "T1",
      key: "t1",
      title: "Rotate",
      state: "dismissed",
      userChangedAt: "2026-01-01T00:00:04.000Z",
    },
  ]);

  it("lists only questions the user dismissed", () => {
    expect(dismissals.map((dismissal) => [dismissal.questionId, dismissal.title])).toEqual([
      ["Q2", "Old?"],
      ["Q3", "Flag?"],
      ["Q4", "Late?"],
    ]);
  });

  it("places each dismissal where it happened and leaves out one older than the loaded history", () => {
    const entries = [
      entry("a", "2026-01-01T00:00:01.000Z"),
      entry("b", "2026-01-01T00:00:02.000Z"),
      entry("c", "2026-01-01T00:00:03.000Z"),
    ];
    expect(withQuestionDismissals(entries, dismissals, false).map((row) => row.id)).toEqual([
      "a",
      "b",
      "question-dismissed:Q3",
      "c",
      "question-dismissed:Q4",
    ]);
    // With the whole history loaded, one older than the first message leads it.
    expect(withQuestionDismissals(entries, dismissals, true).map((row) => row.id)).toEqual([
      "question-dismissed:Q2",
      "a",
      "b",
      "question-dismissed:Q3",
      "c",
      "question-dismissed:Q4",
    ]);
    expect(withQuestionDismissals(entries, [], false)).toBe(entries);
    expect(withQuestionDismissals([], dismissals, false).map((row) => row.id)).toEqual([
      "question-dismissed:Q2",
      "question-dismissed:Q3",
      "question-dismissed:Q4",
    ]);
  });
});
