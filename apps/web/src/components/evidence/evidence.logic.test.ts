import { describe, expect, it } from "vite-plus/test";

import { coverageDraft, failedQaDraft, leavesNeedsQa } from "./evidence.logic";

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
          { sha: "f78458466e0123", subject: "Merge branch 'a'", committedAt: "" },
          { sha: "fd2bcbdbd20123", subject: "Merge branch 'b'", committedAt: "" },
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
