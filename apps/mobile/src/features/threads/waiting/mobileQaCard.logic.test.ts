import type { QaChange } from "@t3tools/client-runtime/qa-card";
import {
  EVIDENCE_THREAD_LANDING_LIMIT,
  ThreadId,
  WaitingItemContextRecord,
  type EvidenceChangeQa,
  type EvidenceLanding,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  findQaChange,
  qaCapturePreview,
  qaDiscussRecord,
  qaFullText,
  qaHistory,
  qaHistoryCapped,
  qaLandedLine,
} from "./mobileQaCard.logic";

const decodeWaitingItem = Schema.decodeSync(WaitingItemContextRecord);

const qa = (overrides: Partial<EvidenceChangeQa> = {}): EvidenceChangeQa => ({
  state: "pending",
  note: "",
  updatedAt: "2026-11-25T10:00:00.000Z",
  by: "server",
  ref: 3,
  raised: ["gaps"],
  ...overrides,
});

const change = (overrides: Partial<QaChange> = {}): QaChange => ({
  id: "change-a",
  ask: "Make the strip compact",
  commits: [],
  summary: "Compact waiting strip",
  review: { verdict: "approved" },
  captures: [],
  gaps: [],
  qa: qa(),
  ...overrides,
});

const landing: EvidenceLanding = {
  id: "landing-1",
  title: "Strip",
  target: { branch: "main", sha: "0123456789abcdef" },
  verifications: [],
  changes: [change()],
  threadId: ThreadId.make("thread-1"),
  projectId: null,
  landedAt: "2026-11-25T10:00:00.000Z",
  updatedAt: "2026-11-25T10:00:00.000Z",
};

it("adds the ask to the landed line only when the title is not the ask", () => {
  expect(qaLandedLine(landing, change())).toBe(
    "Landed on main · 0123456 · from “Make the strip compact”",
  );
  expect(qaLandedLine(landing, change({ summary: "" }))).toBe("Landed on main · 0123456");
});

it("keeps a multiline summary or ask whole, and nothing when one line says it all", () => {
  expect(qaFullText("  Fix the strip\n\n- keep it compact\n- no overlap \n")).toBe(
    "Fix the strip\n\n- keep it compact\n- no overlap",
  );
  expect(qaFullText("Fix the strip")).toBeNull();
  expect(qaFullText("Fix the strip\n   \n")).toBeNull();
  expect(qaFullText("")).toBeNull();
});

it("finds a row's change among the thread's landings", () => {
  expect(findQaChange([landing], { landingId: "landing-1", changeId: "change-a" })?.change.id).toBe(
    "change-a",
  );
  expect(findQaChange([landing], { landingId: "landing-1", changeId: "gone" })).toBeNull();
});

it("builds a Discuss reference the composer context contract accepts", () => {
  const record = qaDiscussRecord(landing, change());
  expect(decodeWaitingItem(record)).toEqual(record);
  expect(record).toMatchObject({
    itemKind: "qa",
    key: "landing-1/change-a",
    ref: "QA3",
    title: "Compact waiting strip",
    sha: "0123456789abcdef",
  });
});

describe("qaHistory", () => {
  const at = (minute: number) => `2026-11-25T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const history = qaHistory(
    [
      {
        ...landing,
        changes: [
          change({ id: "confirmed", qa: qa({ state: "confirmed", by: "user", updatedAt: at(1) }) }),
          change({ id: "fixing", qa: qa({ state: "problem", by: "agent", updatedAt: at(3) }) }),
          change({ id: "dismissed", qa: qa({ state: "waived", by: "user", updatedAt: at(2) }) }),
          change({ id: "open", qa: qa() }),
          change({ id: "quiet", qa: qa({ state: "quiet", raised: [] }) }),
          change({ id: "legacy", qa: qa({ state: "confirmed", raised: undefined }) }),
          change({ id: "listed", qa: qa({ state: "problem", updatedAt: at(4) }) }),
        ],
      },
    ],
    new Set(["landing-1/listed"]),
  );

  it("lists answered changes newest first, after the waiting rows dropped them", () => {
    expect(history.map((entry) => entry.change.id)).toEqual(["fixing", "dismissed", "confirmed"]);
  });

  it("says older QA may exist once the read returns the server's landing cap", () => {
    const landings = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...landing, id: `landing-${index}` }));
    expect(qaHistoryCapped(landings(EVIDENCE_THREAD_LANDING_LIMIT - 1))).toBe(false);
    expect(qaHistoryCapped(landings(EVIDENCE_THREAD_LANDING_LIMIT))).toBe(true);
  });
});

it.each([
  ["/evidence/run/strip.png", "image"],
  ["/evidence/run/flow.mp4", "video"],
  ["/evidence/run/report.pdf", "pdf"],
  ["/evidence/run/page.html", "document"],
  ["/evidence/run/trace.json", "unavailable"],
  ["/evidence/run/notes", "unavailable"],
] as const)("opens capture %s in the %s viewer", (path, kind) => {
  expect(qaCapturePreview(path).kind).toBe(kind);
});
