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

  it("shows a verdict with no checked reviewer thread as unverified", () => {
    expect(reviewDisplay({ verdict: "approved", by: "opus" })).toEqual({
      label: "unverified review",
      variant: "outline",
      hint: "Reported approved by opus, with no finished reviewer thread behind it.",
      threadId: null,
    });
    // An agent-named or older thread id without the server's check is not proof.
    expect(reviewDisplay({ verdict: "approved", threadId: reviewer })).toMatchObject({
      label: "unverified review",
      threadId: null,
    });
    expect(
      reviewDisplay({ verdict: "approved", threadId: reviewer, check: "unverified" }).label,
    ).toBe("unverified review");
  });

  it("shows a checked verdict as reviewed and says when the server linked it", () => {
    expect(
      reviewDisplay({ verdict: "approved", by: "opus", threadId: reviewer, check: "verified" }),
    ).toEqual({ label: "approved · opus", variant: "success", hint: null, threadId: reviewer });
    expect(
      reviewDisplay({
        verdict: "changes_requested",
        threadId: reviewer,
        linked: "derived",
        check: "verified",
      }),
    ).toMatchObject({ label: "changes requested", variant: "warning", threadId: reviewer });
  });

  it("links a reviewer whose verdict it could not read without calling it reviewed", () => {
    expect(
      reviewDisplay({ verdict: "approved", threadId: reviewer, check: "verdict_unconfirmed" }),
    ).toMatchObject({ label: "verdict not confirmed", variant: "outline", threadId: reviewer });
  });

  it("puts a waiver's reason next to it and still reads a waiver from before reasons", () => {
    expect(reviewDisplay({ verdict: "waived", reason: "one-line fix" }).label).toBe(
      "review waived: one-line fix",
    );
    expect(reviewDisplay({ verdict: "waived" }).label).toBe("review waived");
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
