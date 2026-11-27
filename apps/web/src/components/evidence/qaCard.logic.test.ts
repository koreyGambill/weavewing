import { MessageId, RunId, ThreadId, type EvidenceChangeQa } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { placedLandingIds, timelineMayHoldQa, withLandingCards } from "./qaCard.logic";

const qa = (overrides: Partial<EvidenceChangeQa>): EvidenceChangeQa => ({
  state: "pending",
  note: "",
  updatedAt: "2026-11-25T10:00:00.000Z",
  by: "server",
  raised: ["gaps"],
  ...overrides,
});

describe("withLandingCards", () => {
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
      ids(withLandingCards(lead, entries, [landing("l1", "2026-11-25T10:10:00Z") as never])),
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
    expect(ids(withLandingCards(lead, entries, [grandchild as never]))).toEqual([
      "before",
      "turn-start",
      "turn-end",
      "cards:l1",
      "later",
    ]);
    const late = landing("l2", "2026-11-25T11:00:00Z");
    expect(ids(withLandingCards(lead, entries, [late as never])).at(-1)).toBe("cards:l2");
  });

  it("reads and places a child's landing in a lead whose timeline names no child or landing", () => {
    // Ordinary turns only: no evidence_record call and no completion message from the child.
    const entries = [
      work("ask", "2026-11-25T10:00:00Z", "run-1"),
      work("next-start", "2026-11-25T10:20:00Z", "run-2"),
      work("next-end", "2026-11-25T10:25:00Z", "run-2"),
    ];
    expect(timelineMayHoldQa(entries, false, false)).toBe(false);
    expect(timelineMayHoldQa(entries, true, false)).toBe(true);
    expect(
      ids(withLandingCards(lead, entries, [landing("l1", "2026-11-25T10:10:00Z") as never])),
    ).toEqual(["ask", "next-start", "next-end", "cards:l1"]);
  });

  it("asks for at most 200 landings, keeping those nearest the end of the loaded timeline", () => {
    const entries = Array.from({ length: 201 }, (_, index): TimelineEntry => ({
      id: `call-${index}`,
      kind: "thread-evidence",
      createdAt: `2026-11-25T10:00:00Z`,
      runId: null,
      landingIds: [`landing-${String(index).padStart(3, "0")}`],
    }));
    const requested = placedLandingIds(entries);
    expect(requested).toHaveLength(200);
    expect(requested).not.toContain("landing-000");
    expect(requested).toContain("landing-200");
  });

  it("asks for every landing the timeline places at its own calls, once each", () => {
    const placed = (id: string, landingIds: ReadonlyArray<string>): TimelineEntry => ({
      id,
      kind: "thread-evidence",
      createdAt: "2026-11-25T10:00:00Z",
      runId: null,
      landingIds,
    });
    expect(
      placedLandingIds([
        placed("b", ["landing-b"]),
        work("w", "2026-11-25T10:01:00Z", "run-1"),
        placed("a", ["landing-a", "landing-b"]),
      ]),
    ).toEqual(["landing-a", "landing-b"]);
  });

  it("leaves the lead's placed or settled landings and other threads' landings alone", () => {
    const call: TimelineEntry = {
      id: "call",
      kind: "thread-evidence",
      createdAt: "2026-11-25T10:00:00Z",
      runId: null,
      landingIds: ["own"],
    };
    const entries = [call, work("a", "2026-11-25T10:01:00Z", "run-1")];
    const own = { ...landing("own", "2026-11-25T09:00:00Z"), threadId: lead };
    const settled = {
      ...landing("settled", "2026-11-25T08:00:00Z"),
      threadId: lead,
      changes: [{ qa: qa({ state: "confirmed", by: "user" }) }],
    };
    const elsewhere = { ...landing("x", "2026-11-25T09:00:00Z"), qaThreadId: child };
    expect(withLandingCards(lead, entries, [own, settled, elsewhere] as never)).toBe(entries);
  });

  it("puts the lead's waiting card whose call is not loaded at the loaded edge", () => {
    const entries = [
      work("loaded-start", "2026-11-25T10:00:00Z", "run-9"),
      work("later", "2026-11-25T10:05:00Z", "run-9"),
    ];
    const old = { ...landing("old-own", "2026-11-01T09:00:00Z"), threadId: lead };
    const fixing = {
      ...landing("fixing-own", "2026-11-02T09:00:00Z"),
      threadId: lead,
      changes: [{ qa: qa({ state: "problem", by: "agent" }) }],
    };
    expect(ids(withLandingCards(lead, entries, [fixing, old] as never))).toEqual([
      "cards:old-own,fixing-own",
      "loaded-start",
      "later",
    ]);
  });
});

describe("timelineMayHoldQa", () => {
  it("reads landings while the strip lists a QA change, even with nowhere else to put them", () => {
    const entries: ReadonlyArray<TimelineEntry> = [
      {
        id: "ask",
        kind: "work",
        createdAt: "2026-11-25T10:00:00Z",
        entry: {
          id: "ask",
          createdAt: "2026-11-25T10:00:00Z",
          label: "ask",
          tone: "tool",
          runId: RunId.make("run-1"),
        },
      },
    ];
    expect(timelineMayHoldQa(entries, false, false)).toBe(false);
    expect(timelineMayHoldQa(entries, false, true)).toBe(true);
  });
});
