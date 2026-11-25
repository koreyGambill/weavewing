import { describe, expect, it } from "vite-plus/test";

import {
  type DelegatedTask,
  matchReviewTask,
  reviewVerdictFromText,
  selectThreadReview,
} from "./reviewLink.ts";

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
  result: role === "review" ? "Verdict: approved" : "Done.",
  ...extra,
});

interface Scope {
  readonly branch?: string;
  readonly commits?: ReadonlyArray<string>;
  /** Other changes landing alongside this one. */
  readonly alongside?: ReadonlyArray<{ readonly branch?: string; readonly commits?: string[] }>;
}

const scopeOf = (options: Scope) => {
  const change = {
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    commits: options.commits ?? [],
  };
  const others = (options.alongside ?? []).map((other) => ({
    ...other,
    commits: other.commits ?? [],
  }));
  return { change, landing: [change, ...others], targetBranch: "main", landedAt: at(50) };
};

const match = (tasks: ReadonlyArray<DelegatedTask>, options: Scope = {}) =>
  matchReviewTask({ ...scopeOf(options), tasks })?.childThreadId ?? null;

describe("matchReviewTask", () => {
  it("links the reviewer whose brief names the change's branch", () => {
    const tasks = [
      task("impl-a", "implementation", 1, { prompt: "Build feat-a." }),
      task("review-a", "review", 3, { prompt: "Review branch feat-a." }),
      task("review-b", "review", 4, { prompt: "Review branch feat-b." }),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBe("review-a");
    expect(match(tasks, { branch: "feat-b" })).toBe("review-b");
  });

  it("links nothing when no brief names the change, however close in time a review ran", () => {
    const tasks = [
      task("impl-a", "implementation", 1, { prompt: "Build feat-a." }),
      task("review", "review", 3, { prompt: "Review the change." }),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBeNull();
    expect(match(tasks)).toBeNull();
  });

  it.each([
    "feat-export-v2",
    "feat-export+v2",
    "feat-export.v2",
    "feat-export/v2",
    "x/feat-export",
    "feat-export_v2",
    "feat-export..main",
    "feat-export;",
    "**feat-export_",
  ])("does not read %j as naming feat-export", (named) => {
    const tasks = [task("review", "review", 3, { prompt: `Review ${named} please` })];
    expect(match(tasks, { branch: "feat-export" })).toBeNull();
  });

  it.each([
    "Review feat-export",
    "Review feat-export.",
    "Review feat-export. Then stop.",
    "Review `feat-export`",
    "Review (feat-export), carefully",
    'Review "feat-export"',
    "Review 'feat-export': it changes the API",
    "Review **feat-export**",
    "feat-export\nneeds a review",
  ])("reads %j as naming feat-export", (prompt) => {
    const tasks = [task("review", "review", 3, { prompt })];
    expect(match(tasks, { branch: "feat-export" })).toBe("review");
  });

  it("links the reviewer whose brief names a commit as a whole prefix of seven or more", () => {
    const tasks = [
      task("review-a", "review", 3, { prompt: "Check 1a2b3c4d5e6f against main." }),
      task("review-b", "review", 4, { prompt: "Check 9f8e7d6 against main." }),
      task("review-c", "review", 5, { prompt: "Check x5d6e7f8a and feat-5d6e7f8." }),
      task("review-d", "review", 6, { prompt: "Check 0a1b2c3." }),
    ];
    expect(match(tasks, { commits: ["1a2b3c4d5e6f0011"] })).toBe("review-a");
    expect(match(tasks, { commits: ["9f8e7d6c5b4a"] })).toBe("review-b");
    expect(match(tasks, { commits: ["5d6e7f8"] })).toBeNull();
    // A token longer than the recorded id is not a prefix of it.
    expect(match(tasks, { commits: ["1a2b3c4"] })).toBeNull();
    // Six characters are too short to name a commit.
    expect(
      match([task("review", "review", 3, { prompt: "Check 0a1b2c." })], { commits: ["0a1b2c3"] }),
    ).toBeNull();
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
      task("reviewer", "review", 3, { prompt: "Review feat-b.", result: "Verdict: approved" }),
      task("reviewer", "review", 9, { prompt: "Now review feat-a.", result: null }),
    ];
    // The follow-up that names feat-a has no result yet, so nothing backs feat-a.
    expect(match(tasks, { branch: "feat-a" })).toBeNull();
    expect(match(tasks, { branch: "feat-b" })).toBe("reviewer");
  });

  it("does not let one brief back two changes of the same landing", () => {
    const both = task("both", "review", 3, { prompt: "Review feat-a and feat-b." });
    const landing = (branch: string, other: string) => ({ branch, alongside: [{ branch: other }] });
    expect(match([both], landing("feat-a", "feat-b"))).toBeNull();
    expect(match([both], landing("feat-b", "feat-a"))).toBeNull();
    // A brief naming another change's commit counts as naming that change.
    const byCommit = task("by-commit", "review", 3, { prompt: "Review feat-a and 9f8e7d6." });
    expect(
      match([byCommit], { branch: "feat-a", alongside: [{ commits: ["9f8e7d6"] }] }),
    ).toBeNull();
    // With a separate task per change, each change gets its own.
    const separate = [
      both,
      task("reviewer", "review", 4, { prompt: "Review feat-a." }),
      task("reviewer", "review", 6, {
        prompt: "Review feat-b.",
        result: "Verdict: changes requested",
      }),
    ];
    expect(match(separate, landing("feat-a", "feat-b"))).toBe("reviewer");
    // Naming a branch that is not in this landing is allowed.
    expect(match([both], { branch: "feat-a" })).toBe("both");
  });

  it("ignores a review still running or finished after the landing", () => {
    const tasks = [
      task("running", "review", 3, { prompt: "Review feat-a.", completedAt: null, result: null }),
      task("late", "review", 4, { prompt: "Review feat-a.", completedAt: at(55) }),
    ];
    expect(match(tasks, { branch: "feat-a" })).toBeNull();
  });

  it("ignores a brief that only names the target branch, and tasks of other roles", () => {
    const tasks = [
      task("review", "review", 3, { prompt: "Review what lands on main." }),
      task("helper", "research", 4, { prompt: "Look at feat." }),
      task("legacy", null, 5, { prompt: "Review feat." }),
    ];
    expect(match(tasks, { branch: "main" })).toBeNull();
    expect(match(tasks, { branch: "feat" })).toBeNull();
  });
});

describe("selectThreadReview", () => {
  const select = (
    threadTasks: ReadonlyArray<DelegatedTask>,
    options: Scope & { readonly knownBranches?: ReadonlyArray<string> } = {},
  ) =>
    selectThreadReview({
      ...scopeOf(options),
      threadTasks,
      knownBranches: options.knownBranches ?? [],
    })?.result ?? null;

  it("binds to the task whose brief names this change, not the thread's latest", () => {
    const tasks = [
      task("reviewer", "review", 21, { prompt: "Review feat-first", result: "Verdict: approved" }),
      task("reviewer", "review", 22, {
        prompt: "Review feat-second",
        result: "Verdict: changes requested",
      }),
    ];
    expect(select(tasks, { branch: "feat-first" })).toBe("Verdict: approved");
    expect(select(tasks, { branch: "feat-second" })).toBe("Verdict: changes requested");
  });

  it("uses a thread's only finished review when its brief names nothing", () => {
    expect(select([task("reviewer", "review", 3)], { branch: "feat-a" })).toBe("Verdict: approved");
  });

  it("declines when the only review names something else or the choice is ambiguous", () => {
    const one = (prompt: string) => [task("reviewer", "review", 3, { prompt })];
    expect(select(one("Review 9f8e7d6."), { branch: "feat-a" })).toBeNull();
    expect(
      select(one("Review feat-b."), { branch: "feat-a", knownBranches: ["feat-b"] }),
    ).toBeNull();
    expect(
      select(one("Review feat-b."), { branch: "feat-a", alongside: [{ branch: "feat-b" }] }),
    ).toBeNull();
    const twoUnnamed = [task("reviewer", "review", 3), task("reviewer", "review", 9)];
    expect(select(twoUnnamed, { branch: "feat-a" })).toBeNull();
    const twoNamed = [
      task("reviewer", "review", 3, { prompt: "Review feat-a." }),
      task("reviewer", "review", 9, { prompt: "Re-check feat-a." }),
    ];
    expect(select(twoNamed, { branch: "feat-a" })).toBeNull();
  });
});

describe("reviewVerdictFromText", () => {
  it.each([
    ["Two findings.\n\nVerdict: changes requested", "changes_requested"],
    ["Verdict: approved", "approved"],
    ["verdict: APPROVED  \n\n", "approved"],
    ["Notes.\n\n```ts\nconst x = 1;\n```\n\nVerdict: approved", "approved"],
    ["- item one\n> quoted text\n\nVerdict: changes requested\r\n", "changes_requested"],
  ] as const)("reads %j as %s", (text, verdict) => {
    expect(reviewVerdictFromText(text)).toBe(verdict);
  });

  it.each([
    ["no verdict", "Looks good to me."],
    ["a verdict that is not the last line", "Verdict: approved\n\nThanks."],
    ["a conditional verdict", "Verdict: approved only after tests pass"],
    ["a bold verdict with a clause", "**Verdict: approved** only after tests pass"],
    ["a bold verdict", "**Verdict: approved**"],
    ["a trailing full stop", "Verdict: approved."],
    ["another verdict value", "Verdict: approve"],
    ["a list marker", "- Verdict: approved"],
    ["an indented code sample", "Example output:\n\n    Verdict: approved"],
    [
      "a four-backtick fence holding shorter fences",
      "- Example output:\n  ````markdown\n  ```\n  Verdict: approved\n  ```\n  ````",
    ],
    ["an unclosed fence", "Example:\n```\nVerdict: approved"],
    ["an earlier verdict", "Verdict: changes requested\n\nVerdict: approved"],
    ["an earlier quoted verdict", "> Verdict: changes requested\n\nVerdict: approved"],
    ["an earlier bold verdict", "**Verdict — request changes.**\n\nVerdict: approved"],
    ["an earlier fenced verdict", "```\nVerdict: changes requested\n```\nVerdict: approved"],
  ])("leaves %s unconfirmed", (_name, text) => {
    expect(reviewVerdictFromText(text)).toBeNull();
  });
});
