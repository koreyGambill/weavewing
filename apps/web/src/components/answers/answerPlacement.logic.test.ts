import { MessageId, type TrackedAsk } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { withUnplacedAnswerCards } from "./answerPlacement.logic";

it("puts the latest waiting answer at the loaded start when only its earlier call is loaded", () => {
  const at = "2026-11-01T12:00:00.000Z";
  const ask: TrackedAsk = {
    id: "A2",
    state: "answered",
    question: "What resets the counter?",
    askedInMessageId: MessageId.make("message"),
    createdAt: at,
    closedAt: null,
    answers: [
      { n: 1, text: "One handler.", answeredAt: at, runId: null },
      { n: 2, text: "Two handlers.", answeredAt: at, runId: null },
    ],
    followUps: [],
  };
  const older = {
    kind: "thread-answer" as const,
    id: "older-call",
    createdAt: at,
    runId: null,
    answerRef: { id: "A2", n: 1 },
  };
  const entries = withUnplacedAnswerCards([older], [ask]);
  expect(entries.map((entry) => entry.id)).toEqual(["tracked-answer-fallback:A2", "older-call"]);
  expect(entries[0]).toMatchObject({ answerRef: { id: "A2", n: 2 } });
  expect(withUnplacedAnswerCards(entries, [ask])).toBe(entries);
  expect(withUnplacedAnswerCards([older], [{ ...ask, state: "closed" }])).toEqual([older]);
});
