import { MessageId, RunId, ThreadId, type EvidenceChangeQa } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import {
  qaCardOutcome,
  qaCardStatus,
  qaCardTitle,
  qaPresence,
  withChildLandingCards,
} from "./qaCard.logic";

const qa = (overrides: Partial<EvidenceChangeQa>): EvidenceChangeQa => ({
  state: "pending",
  note: "",
  updatedAt: "2026-11-25T10:00:00.000Z",
  by: "server",
  raised: ["gaps"],
  ...overrides,
});

describe("qaCardStatus", () => {
  it.each([
    [qa({}), false, "open"],
    [qa({}), true, "in-composer"],
    [qa({ discussedMessageId: MessageId.make("message-1") }), false, "discussing"],
    [qa({ discussedMessageId: MessageId.make("message-1") }), true, "in-composer"],
    [qa({ state: "confirmed", by: "user" }), false, "confirmed-by-you"],
    [qa({ state: "confirmed", by: "agent" }), false, "recorded"],
    [qa({ state: "waived", by: "agent", note: "Not needed" }), false, "recorded"],
    [qa({ state: "problem", by: "agent", note: "Overlaps" }), false, "agent-fixing"],
    [qa({ state: "waived", by: "user" }), false, "dismissed"],
  ] as const)("%o in composer %s reads %s", (value, inComposer, expected) => {
    expect(qaCardStatus(value, inComposer)).toBe(expected);
  });

  it("names the outcome a settled card's line shows", () => {
    expect(qaCardOutcome(qa({ state: "confirmed" }))).toBe("Looks good");
    expect(qaCardOutcome(qa({ state: "problem" }))).toBe("Problem");
    expect(qaCardOutcome(qa({ state: "waived", by: "agent" }))).toBe("Dismissed");
    expect(qaCardOutcome(qa({ state: "waived", by: "user" }))).toBeNull();
    expect(qaCardOutcome(qa({}))).toBeNull();
  });
});

describe("qaPresence", () => {
  it("shows a card for a raised change, a line for a quiet one", () => {
    expect(qaPresence(qa({}))).toBe("card");
    expect(qaPresence(qa({ state: "quiet", raised: [] }))).toBe("quiet");
  });

  it("shows a legacy landing's change only while it waits on the user", () => {
    const { raised: _raised, ...legacy } = qa({ by: "user" });
    expect(qaPresence(legacy)).toBe("card");
    for (const state of ["confirmed", "waived", "problem"] as const)
      expect(qaPresence({ ...legacy, state })).toBe("none");
  });
});

describe("qaCardTitle", () => {
  it("uses the summary's first line, else the ask's", () => {
    expect(qaCardTitle({ id: "a", summary: "Toast shows retries\nMore", ask: "Ask" })).toBe(
      "Toast shows retries",
    );
    expect(qaCardTitle({ id: "a", summary: "", ask: "Show retries\nin the toast" })).toBe(
      "Show retries",
    );
  });
});

describe("withChildLandingCards", () => {
  const lead = ThreadId.make("lead");
  const child = ThreadId.make("child");
  const work = (id: string, createdAt: string, runId: string): TimelineEntry => ({
    id,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label: id, tone: "tool", runId: RunId.make(runId) },
  });
  const completion = (id: string, createdAt: string, threadId: ThreadId): TimelineEntry => ({
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role: "user",
      text: "Child finished",
      createdAt,
      updatedAt: createdAt,
      runId: null,
      streaming: false,
      origin: {
        kind: "subagent",
        event: "completed",
        title: "Implement",
        threadId,
        environmentId: "env" as never,
      },
    },
  });
  const landing = (id: string, landedAt: string, threadId = child) => ({
    id,
    threadId,
    qaThreadId: lead,
    landedAt,
    changes: [{ qa: qa({}) }],
  });
  const ids = (entries: ReadonlyArray<TimelineEntry>) =>
    entries.map((entry) =>
      entry.kind === "thread-evidence" ? `cards:${entry.landingIds.join(",")}` : entry.id,
    );

  it("puts a child's landing at the lead's completion item for that child", () => {
    const entries = [
      work("delegate", "2026-11-25T10:00:00Z", "run-1"),
      completion("done-other", "2026-11-25T10:20:00Z", ThreadId.make("other-child")),
      completion("done-child", "2026-11-25T10:30:00Z", child),
      work("next", "2026-11-25T10:40:00Z", "run-2"),
    ];
    expect(
      ids(withChildLandingCards(lead, entries, [landing("l1", "2026-11-25T10:10:00Z") as never])),
    ).toEqual(["delegate", "done-other", "done-child", "cards:l1", "next"]);
  });

  it("falls back to the end of the lead's next turn, then to the end", () => {
    const entries = [
      work("before", "2026-11-25T09:00:00Z", "run-1"),
      work("turn-start", "2026-11-25T10:20:00Z", "run-2"),
      work("turn-end", "2026-11-25T10:25:00Z", "run-2"),
      work("later", "2026-11-25T10:40:00Z", "run-3"),
    ];
    const grandchild = landing("l1", "2026-11-25T10:10:00Z", ThreadId.make("grandchild"));
    expect(ids(withChildLandingCards(lead, entries, [grandchild as never]))).toEqual([
      "before",
      "turn-start",
      "turn-end",
      "cards:l1",
      "later",
    ]);
    const late = landing("l2", "2026-11-25T11:00:00Z");
    expect(ids(withChildLandingCards(lead, entries, [late as never])).at(-1)).toBe("cards:l2");
  });

  it("leaves the lead's own landings and other threads' landings to their own rows", () => {
    const entries = [work("a", "2026-11-25T10:00:00Z", "run-1")];
    const own = { ...landing("own", "2026-11-25T09:00:00Z"), threadId: lead };
    const elsewhere = { ...landing("x", "2026-11-25T09:00:00Z"), qaThreadId: child };
    expect(withChildLandingCards(lead, entries, [own, elsewhere] as never)).toBe(entries);
  });
});
