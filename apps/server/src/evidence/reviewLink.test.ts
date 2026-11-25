import { describe, expect, it } from "vite-plus/test";

import { type DelegatedTask, matchReviewTask, reviewVerdictFromText } from "./reviewLink.ts";

const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`;

const task = (
  childThreadId: string,
  role: DelegatedTask["role"],
  minute: number,
  extra: Partial<DelegatedTask> = {},
): DelegatedTask => ({
  childThreadId,
  role,
  startedAt: at(minute),
  completedAt: at(minute + 1),
  prompt: "Review the change.",
  result: role === "review" ? "Verdict: approve" : "Done.",
  branch: null,
  ...extra,
});

const match = (
  tasks: ReadonlyArray<DelegatedTask>,
  options: {
    readonly branch?: string;
    readonly commits?: ReadonlyArray<string>;
    readonly implementerThreadId?: string;
  } = {},
) =>
  matchReviewTask({
    change: {
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      commits: options.commits ?? [],
    },
    targetBranch: "main",
    landedAt: at(50),
    implementerThreadId: options.implementerThreadId ?? null,
    tasks,
  })?.childThreadId ?? null;

describe("matchReviewTask", () => {
  it("links the reviewer whose brief names the change's branch", () => {
    const tasks = [
      task("impl-a", "implementation", 1, { branch: "feat-a" }),
      task("impl-b", "implementation", 2, { branch: "feat-b" }),
      task("review-a", "review", 3, { prompt: "Review branch feat-a." }),
      task("review-b", "review", 4, { prompt: "Review branch feat-b." }),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBe("review-a");
    expect(match(tasks, { branch: "feat-b" })).toBe("review-b");
  });

  it("matches a branch only as a whole name", () => {
    const tasks = [task("review-v2", "review", 3, { prompt: "Review feat-export-v2 and feat/x." })];
    expect(match(tasks, { branch: "feat-export" })).toBeNull();
    expect(match(tasks, { branch: "feat-export-v2" })).toBe("review-v2");
    expect(match(tasks, { branch: "feat" })).toBeNull();
  });

  it("links the reviewer whose brief names a commit, short or full, as a whole token", () => {
    const tasks = [
      task("review-a", "review", 3, { prompt: "Check 1a2b3c4d5e6f against main." }),
      task("review-b", "review", 4, { prompt: "Check 9f8e7d6 against main." }),
      task("review-c", "review", 5, { prompt: "Check x5d6e7f8a." }),
    ];
    expect(match(tasks, { commits: ["1a2b3c4"] })).toBe("review-a");
    expect(match(tasks, { commits: ["9f8e7d6c5b4a"] })).toBe("review-b");
    expect(match(tasks, { commits: ["5d6e7f8"] })).toBeNull();
  });

  it("prefers the latest named reviewer, so a re-check supersedes the first round", () => {
    const tasks = [
      task("review-1", "review", 3, { prompt: "Review feat-a." }),
      task("review-2", "review", 9, { prompt: "Re-check feat-a after fixes." }),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBe("review-2");
  });

  it("takes the scope from each task, so a follow-up's brief matches its own result", () => {
    const tasks = [
      task("reviewer", "review", 3, { prompt: "Review feat-b.", result: "Verdict: approve" }),
      task("reviewer", "review", 9, { prompt: "Now review feat-a.", result: null }),
    ];
    // The follow-up that names feat-a has no result yet, so nothing backs feat-a.
    expect(match(tasks, { branch: "feat-a" })).toBeNull();
    expect(match(tasks, { branch: "feat-b" })).toBe("reviewer");
  });

  it("ignores a review still running or finished after the landing", () => {
    const tasks = [
      task("running", "review", 3, { prompt: "Review feat-a.", completedAt: null, result: null }),
      task("late", "review", 4, { prompt: "Review feat-a.", completedAt: at(55) }),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBeNull();
  });

  it("ignores a brief that only names the target branch", () => {
    const tasks = [task("review", "review", 3, { prompt: "Review what lands on main." })];
    expect(match(tasks, { branch: "main" })).toBeNull();
  });

  it("falls back to the reviewer started after the implementing child and before the next one", () => {
    const tasks = [
      task("impl-a", "implementation", 1, { branch: "feat-a" }),
      task("review-a", "review", 3),
      task("impl-b", "implementation", 10, { branch: "feat-b" }),
      task("review-b", "review", 12),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBe("review-a");
    expect(match(tasks, { branch: "feat-b" })).toBe("review-b");
  });

  it("links nothing by time when two implementation lanes are open at once", () => {
    const tasks = [
      task("impl-a", "implementation", 1, { branch: "feat-a" }),
      task("impl-b", "implementation", 2, { branch: "feat-b" }),
      task("review-1", "review", 5),
      task("review-2", "review", 7),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBeNull();
    expect(match(tasks, { branch: "feat-b" })).toBeNull();
  });

  it("uses the landing's own thread as the implementer when a child recorded it", () => {
    const tasks = [
      task("impl-a", "implementation", 1),
      task("review-a", "review", 3),
      task("impl-b", "implementation", 10),
    ];
    expect(match(tasks, { implementerThreadId: "impl-a" })).toBe("review-a");
  });

  it("links nothing when the implementer is ambiguous or the role is missing", () => {
    const tasks = [
      task("impl-a", "implementation", 1, { branch: "feat" }),
      task("impl-b", "implementation", 2, { branch: "feat" }),
      task("review", "review", 3),
      task("helper", "research", 4, { prompt: "Look at feat." }),
      task("legacy", null, 5, { prompt: "Review feat." }),
    ];
    expect(match(tasks, { branch: "feat" })).toBeNull();
    expect(match(tasks)).toBeNull();
  });
});

describe("reviewVerdictFromText", () => {
  it.each([
    ["Two findings.\n\n**Verdict: request changes.** Fix the race.", "changes_requested"],
    ["Verdict: approve.", "approved"],
    ["- Verdict — approved", "approved"],
    ["Verdict: changes requested", "changes_requested"],
    ["Verdict: LGTM", "approved"],
    ["Verdict: request changes\n\n```\nVerdict: approve\n```", "changes_requested"],
    ["Verdict: request changes.\n\n> Verdict: approve", "changes_requested"],
  ] as const)("reads %j as %s", (text, verdict) => {
    expect(reviewVerdictFromText(text)).toBe(verdict);
  });

  it.each([
    "Looks good to me.",
    "The verdict will follow once tests finish.",
    "Verdict: approve only after tests pass",
    "Verdict: approve with nits",
    "Round 1 verdict: request changes.\nVerdict: request changes\nVerdict: approve",
    "**Verdict — ship-with-fixes. Preserve committed answers.**",
  ])("leaves %j unconfirmed", (text) => {
    expect(reviewVerdictFromText(text)).toBeNull();
  });
});
