import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { EvidenceChange, EvidenceLandingSummary } from "./evidence.ts";

describe("QA checks", () => {
  const decode = Schema.decodeUnknownSync(EvidenceChange);
  const change = {
    id: "settings",
    ask: "Use columns",
    summary: "Settings layout",
    commits: [],
    captures: [],
    gaps: [],
    review: { verdict: "approved" },
  };
  const qaCheck = { where: " Settings ", do: " Widen the window ", expect: " Two columns " };

  it("decodes records with and without a check and trims the check", () => {
    expect(decode(change).qaCheck).toBeUndefined();
    expect(decode({ ...change, qaCheck }).qaCheck).toEqual({
      where: "Settings",
      do: "Widen the window",
      expect: "Two columns",
    });
  });

  it.each(["where", "do", "expect"])("requires a short non-blank %s", (key) => {
    for (const value of [undefined, "  ", "x".repeat(121)]) {
      expect(() => decode({ ...change, qaCheck: { ...qaCheck, [key]: value } })).toThrow();
    }
    expect(() =>
      decode({ ...change, qaCheck: { ...qaCheck, [key]: "x".repeat(120) } }),
    ).not.toThrow();
  });
});

const decodeSummary = Schema.decodeUnknownSync(EvidenceLandingSummary);

const summary = {
  id: "2026-11-26-csv",
  title: "CSV export quoting",
  threadId: "thread-1",
  projectId: null,
  landedAt: "2026-11-26T10:00:00.000Z",
  target: { branch: "main", sha: "abc1234" },
  verifications: [],
  changeCount: 1,
  qa: { pending: 0, quiet: 1, confirmed: 0, problem: 0, waived: 0 },
};

describe("EvidenceLandingSummary", () => {
  it("reads a Notes entry from a server that does not count captures", () => {
    const decoded = decodeSummary({
      ...summary,
      notes: [
        { id: "csv-quote", title: "Quote commas", gapPreviews: ["No live remote."], gapCount: 1 },
      ],
    });
    expect(decoded.notes?.[0]?.captureCount).toBeUndefined();
    expect(decoded.qa.noted).toBeUndefined();
  });
});
