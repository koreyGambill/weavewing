import {
  EnvironmentId,
  ThreadId,
  type EvidenceLandingSummary,
  type EvidenceListResult,
  type EvidenceQaTally,
  type WaitingCounts,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  evidenceButtonLabel,
  evidenceEnvironmentHeading,
  evidenceSheetState,
  evidenceThreadsWaitingCount,
  groupLandings,
  landingQaSummary,
  landingQaThreadId,
  landingTargetLine,
} from "./evidence.logic";

const LAPTOP = EnvironmentId.make("env-laptop");
const SERVER = EnvironmentId.make("env-server");

const counts = (qa: number): WaitingCounts => ({ question: 0, qa, task: 0 });
const tally = (overrides: Partial<EvidenceQaTally> = {}): EvidenceQaTally => ({
  pending: 0,
  quiet: 0,
  confirmed: 0,
  problem: 0,
  waived: 0,
  ...overrides,
});

const summary = (
  id: string,
  qa: Partial<EvidenceQaTally> = {},
  changeCount = 1,
): EvidenceLandingSummary => ({
  id,
  title: `Landing ${id}`,
  threadId: ThreadId.make("thread-1"),
  projectId: null,
  landedAt: "2026-11-25T10:00:00.000Z",
  target: { branch: "main", sha: "0123456789abcdef" },
  verifications: [],
  changeCount,
  qa: tally(qa),
});

const page = (
  items: ReadonlyArray<EvidenceLandingSummary>,
  next: EvidenceListResult["next"] = null,
): EvidenceListResult => ({ items, next });

describe("evidenceThreadsWaitingCount", () => {
  it("counts threads with changes to check, never the changes in them", () => {
    const threads = [
      { environmentId: LAPTOP, archivedAt: null, waitingCounts: counts(25) },
      { environmentId: LAPTOP, archivedAt: null, waitingCounts: counts(1) },
      { environmentId: SERVER, archivedAt: null, waitingCounts: counts(4) },
      { environmentId: SERVER, archivedAt: null, waitingCounts: counts(0) },
    ];
    expect(evidenceThreadsWaitingCount(threads, new Set([LAPTOP, SERVER]))).toBe(3);
  });

  it("leaves out archived threads, threads without counts and environments not listed", () => {
    const threads = [
      { environmentId: LAPTOP, archivedAt: "2026-11-24T10:00:00.000Z", waitingCounts: counts(3) },
      { environmentId: LAPTOP, archivedAt: null },
      { environmentId: SERVER, archivedAt: null, waitingCounts: counts(2) },
      { environmentId: LAPTOP, archivedAt: null, waitingCounts: counts(1) },
    ];
    expect(evidenceThreadsWaitingCount(threads, new Set([LAPTOP]))).toBe(1);
  });
});

it.each([
  [0, "Evidence"],
  [1, "Evidence, 1 thread has changes to check"],
  [3, "Evidence, 3 threads have changes to check"],
])("labels the entry for %i threads waiting as %s", (threads, label) => {
  expect(evidenceButtonLabel(threads)).toBe(label);
});

it("counts a landing's QA in web's words and order, leaving out empty states", () => {
  expect(landingQaSummary(summary("a", { pending: 2, quiet: 1, waived: 1 }, 4))).toBe(
    "2 open · 1 dismissed · 1 nothing to check · 4 changes",
  );
  expect(landingQaSummary(summary("b", { confirmed: 1 }))).toBe("1 confirmed · 1 change");
});

it("names where a landing went and the thread that shows its QA", () => {
  expect(landingTargetLine(summary("a"))).toBe("main · 0123456");
  const lead = ThreadId.make("lead");
  const child = ThreadId.make("child");
  expect(landingQaThreadId({ threadId: child, qaThreadId: lead })).toBe(lead);
  expect(landingQaThreadId({ threadId: child })).toBe(child);
});

it("drops landings that need QA from the Landed group, so none shows twice", () => {
  const items = [
    summary("pending", { pending: 1 }),
    summary("problem", { problem: 1, confirmed: 1 }),
    summary("settled", { confirmed: 1, quiet: 2 }),
  ];
  expect(groupLandings("needs-qa", items).map((landing) => landing.id)).toEqual([
    "pending",
    "problem",
    "settled",
  ]);
  expect(groupLandings("landed", items).map((landing) => landing.id)).toEqual(["settled"]);
});

describe("evidenceSheetState", () => {
  const loaded = (
    needsQa: ReadonlyArray<EvidenceLandingSummary>,
    all: ReadonlyArray<EvidenceLandingSummary>,
    next: EvidenceListResult["next"] = null,
  ) => ({ needsQa: page(needsQa), all: page(all, next), failed: false });

  it("loads until every environment answers, then shows the empty state", () => {
    const empty = loaded([], []);
    expect(evidenceSheetState([empty, { needsQa: null, all: null, failed: false }])).toEqual({
      kind: "loading",
    });
    expect(evidenceSheetState([empty, empty])).toEqual({ kind: "empty" });
    expect(evidenceSheetState([])).toEqual({ kind: "empty" });
  });

  it("says nothing waits when every landing is settled", () => {
    expect(evidenceSheetState([loaded([], [summary("a", { confirmed: 1 })])])).toEqual({
      kind: "listed",
      needsQaEmpty: true,
      landedEmpty: false,
    });
  });

  it("hides the Landed group only when no environment has another landing, here or older", () => {
    const waiting = summary("a", { pending: 1 });
    expect(evidenceSheetState([loaded([waiting], [waiting])])).toEqual({
      kind: "listed",
      needsQaEmpty: false,
      landedEmpty: true,
    });
    const cursor = { landedAt: "2026-11-20T10:00:00.000Z", id: "a" };
    expect(evidenceSheetState([loaded([waiting], [waiting], cursor)])).toEqual({
      kind: "listed",
      needsQaEmpty: false,
      landedEmpty: false,
    });
  });

  it("never reads a failed environment as empty", () => {
    const failed = { needsQa: null, all: null, failed: true };
    expect(evidenceSheetState([failed])).toEqual({
      kind: "listed",
      needsQaEmpty: false,
      landedEmpty: false,
    });
    expect(evidenceSheetState([loaded([], []), failed])).toEqual({
      kind: "listed",
      needsQaEmpty: false,
      landedEmpty: false,
    });
  });
});

it("labels each environment's lists only when several are listed", () => {
  const laptop = { environmentId: LAPTOP, label: "Laptop" };
  expect(evidenceEnvironmentHeading(laptop, 1)).toBeNull();
  expect(evidenceEnvironmentHeading(laptop, 2)).toBe("Laptop");
});
