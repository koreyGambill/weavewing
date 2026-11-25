import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  checkLabel,
  coverageDraft,
  failedQaDraft,
  leavesNeedsQa,
  reviewDisplay,
} from "./evidence.logic";

describe("failedQaDraft", () => {
  const change = {
    id: "bw-3612",
    ask: "Watcher fires twice\nsecond line",
    ticket: { key: "BW-3612" },
  };

  it.each([
    ["", "QA failed on BW-3612: still two rows\nAsk: Watcher fires twice"],
    ["my draft\n", "my draft\n\nQA failed on BW-3612: still two rows\nAsk: Watcher fires twice"],
  ])("keeps an existing draft %j", (existing, expected) => {
    expect(failedQaDraft(existing, change, " still two rows ")).toBe(expected);
  });
});

describe("coverageDraft", () => {
  it("lists each merge and counts the ones past the cap", () => {
    expect(
      coverageDraft("my draft", {
        branch: "main",
        uncoveredCount: 3,
        uncovered: [
          { sha: "f78458466e0123", subject: "Merge branch 'a'" },
          { sha: "fd2bcbdbd20123", subject: "Merge branch 'b'" },
        ],
      }),
    ).toBe(
      [
        "my draft",
        "",
        "These merges on main have no evidence. Record it with evidence_record, or tell me why none is needed:",
        "- f78458466e Merge branch 'a'",
        "- fd2bcbdbd2 Merge branch 'b'",
        "- and 1 more",
      ].join("\n"),
    );
  });
});

describe("leavesNeedsQa", () => {
  const changes = [
    { id: "a", qa: { state: "confirmed" as const } },
    { id: "b", qa: { state: "pending" as const } },
  ];

  it.each([
    ["b", "confirmed", true],
    ["b", "waived", true],
    ["b", "failed", false],
    ["a", "waived", false],
  ] as const)("setting %s to %s leaves the list: %s", (id, next, expected) => {
    expect(leavesNeedsQa(changes, id, next)).toBe(expected);
  });
});

describe("reviewDisplay", () => {
  const reviewer = ThreadId.make("thread-reviewer");
  const known = (delegateRole?: string) => ({
    ...(delegateRole === undefined ? {} : { delegateRole }),
    archivedAt: null,
    deletedAt: null,
  });

  it("shows every claimed verdict as unverified with the agent's claim readable", () => {
    expect(reviewDisplay({ verdict: "approved", by: "opus" }, null)).toEqual({
      label: "Unverified review · agent reported approved",
      hint: "Reported approved by opus. Reviewer verdicts are not checked yet.",
      link: null,
    });
    expect(reviewDisplay({ verdict: "changes_requested" }, null).label).toBe(
      "Unverified review · agent reported changes requested",
    );
    // Records from development builds that marked a review checked still read as unverified.
    for (const check of ["verified", "verdict_unconfirmed"] as const)
      expect(
        reviewDisplay({ verdict: "approved", threadId: reviewer, check }, known("review")).label,
      ).toBe("Unverified review · agent reported approved");
  });

  it("calls a linked thread the reviewer only when the client knows it as a review delegate", () => {
    expect(
      reviewDisplay({ verdict: "approved", threadId: reviewer }, known("review")).link,
    ).toEqual({ kind: "reviewer", label: "Reviewer", threadId: reviewer });
  });

  it("shows a known thread of another role, or none, as a neutral linked thread", () => {
    for (const target of [known("implementation"), known()])
      expect(reviewDisplay({ verdict: "approved", threadId: reviewer }, target).link).toEqual({
        kind: "linked",
        label: "Linked thread",
        threadId: reviewer,
      });
  });

  it("offers no navigation to a thread the client does not have, or has archived or deleted", () => {
    const at = "2026-11-25T11:00:00.000Z";
    for (const target of [
      null,
      { ...known("review"), archivedAt: at },
      { ...known("review"), deletedAt: at },
    ])
      expect(reviewDisplay({ verdict: "approved", threadId: reviewer }, target).link).toMatchObject(
        { kind: "unavailable", label: "Linked thread unavailable" },
      );
  });

  it("puts a waiver's reason next to it and still reads a waiver from before reasons", () => {
    expect(reviewDisplay({ verdict: "waived", reason: "one-line fix" }, null).label).toBe(
      "review waived: one-line fix",
    );
    expect(reviewDisplay({ verdict: "waived" }, null).label).toBe("review waived");
  });
});

describe("checkLabel", () => {
  it.each([
    [{ label: "e2e", result: "skipped", reason: "no browser" }, "e2e skipped: no browser"],
    [{ label: "e2e", result: "skipped" }, "e2e skipped"],
    [{ label: "unit", result: "pass" }, "unit"],
    [{ label: "unit", result: "fail" }, "unit failed"],
  ] as const)("labels %j", (check, label) => {
    expect(checkLabel(check)).toBe(label);
  });
});
