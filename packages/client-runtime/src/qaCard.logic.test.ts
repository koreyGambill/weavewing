import { MessageId, type EvidenceChangeQa } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { qaCardOutcome, qaCardStatus, qaCardTitle, qaNoted, qaPresence } from "./qaCard.logic.ts";

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

describe("qaNoted", () => {
  it("calls a quiet change with gaps or captures a note, and nothing else", () => {
    const gaps = ["Not run on a phone."];
    const captures: ReadonlyArray<never> = [];
    const shot = [{ path: "/home/user/evidence/acme/after.png", caption: "After" }];
    const quiet = qa({ state: "quiet", raised: [] });
    expect(qaNoted({ qa: quiet, gaps, captures })).toBe(true);
    expect(qaNoted({ qa: quiet, gaps: [], captures: shot })).toBe(true);
    expect(qaNoted({ qa: quiet, gaps: [], captures })).toBe(false);
    expect(qaNoted({ qa: qa({}), gaps, captures: shot })).toBe(false);
    expect(qaNoted({ qa: qa({ state: "confirmed", by: "user" }), gaps, captures })).toBe(false);
  });
});
