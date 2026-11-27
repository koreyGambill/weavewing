import type { TrackedAsk } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";

export function withUnplacedAnswerCards(
  entries: ReadonlyArray<TimelineEntry>,
  asks: ReadonlyArray<TrackedAsk>,
): ReadonlyArray<TimelineEntry> {
  const placed = new Set(
    entries.flatMap((entry) =>
      entry.kind === "thread-answer" ? [`${entry.answerRef.id}/${entry.answerRef.n}`] : [],
    ),
  );
  const unplaced = asks.flatMap((ask): TimelineEntry[] => {
    if (ask.state !== "answered") return [];
    const answer = ask.answers.at(-1);
    if (!answer || placed.has(`${ask.id}/${answer.n}`)) return [];
    return [
      {
        kind: "thread-answer",
        id: `tracked-answer-fallback:${ask.id}`,
        createdAt: entries[0]?.createdAt ?? answer.answeredAt,
        runId: null,
        answerRef: { id: ask.id, n: answer.n },
      },
    ];
  });
  return unplaced.length === 0 ? entries : [...unplaced, ...entries];
}
