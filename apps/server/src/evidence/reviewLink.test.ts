import { describe, expect, it } from "vite-plus/test";

import { type DelegatedChild, matchReviewThread, reviewVerdictFromText } from "./reviewLink.ts";

const child = (
  threadId: string,
  role: DelegatedChild["role"],
  minute: number,
  extra: Partial<DelegatedChild> = {},
): DelegatedChild => ({
  threadId,
  role,
  startedAt: `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`,
  prompt: "Review the change.",
  branch: null,
  ...extra,
});

const match = (
  children: ReadonlyArray<DelegatedChild>,
  options: {
    readonly branch?: string;
    readonly commits?: ReadonlyArray<string>;
    readonly implementerThreadId?: string;
  } = {},
) =>
  matchReviewThread({
    change: {
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      commits: options.commits ?? [],
    },
    targetBranch: "main",
    landedAt: "2026-11-20T11:00:00.000Z",
    implementerThreadId: options.implementerThreadId ?? null,
    children,
  })?.threadId ?? null;

describe("matchReviewThread", () => {
  it("links the reviewer whose brief names the change's branch", () => {
    const children = [
      child("impl-a", "implementation", 1, { branch: "feat-a" }),
      child("impl-b", "implementation", 2, { branch: "feat-b" }),
      child("review-a", "review", 3, { prompt: "Review branch feat-a." }),
      child("review-b", "review", 4, { prompt: "Review branch feat-b." }),
    ];
    expect(match(children, { branch: "feat-a" })).toBe("review-a");
    expect(match(children, { branch: "feat-b" })).toBe("review-b");
  });

  it("links the reviewer whose brief names a commit, short or full", () => {
    const children = [
      child("review-a", "review", 3, { prompt: "Check 1a2b3c4d5e6f against main." }),
      child("review-b", "review", 4, { prompt: "Check 9f8e7d6 against main." }),
    ];
    expect(match(children, { commits: ["1a2b3c4"] })).toBe("review-a");
    expect(match(children, { commits: ["9f8e7d6c5b4a"] })).toBe("review-b");
  });

  it("prefers the latest named reviewer, so a re-check supersedes the first round", () => {
    const children = [
      child("review-1", "review", 3, { prompt: "Review feat-a." }),
      child("review-2", "review", 9, { prompt: "Re-check feat-a after fixes." }),
    ];
    expect(match(children, { branch: "feat-a" })).toBe("review-2");
  });

  it("ignores a brief that only names the target branch", () => {
    const children = [child("review", "review", 3, { prompt: "Review what lands on main." })];
    expect(match(children, { branch: "main" })).toBeNull();
  });

  it("falls back to the reviewer started after the implementing child and before the next one", () => {
    const children = [
      child("impl-a", "implementation", 1, { branch: "feat-a" }),
      child("review-a", "review", 2),
      child("impl-b", "implementation", 3, { branch: "feat-b" }),
      child("review-b", "review", 4),
    ];
    expect(match(children, { branch: "feat-a" })).toBe("review-a");
    expect(match(children, { branch: "feat-b" })).toBe("review-b");
  });

  it("uses the landing's own thread as the implementer when a child recorded it", () => {
    const children = [
      child("impl-a", "implementation", 1),
      child("review-a", "review", 2),
      child("impl-b", "implementation", 3),
    ];
    expect(match(children, { implementerThreadId: "impl-a" })).toBe("review-a");
  });

  it("links nothing when the implementer is ambiguous", () => {
    const children = [
      child("impl-a", "implementation", 1, { branch: "feat" }),
      child("impl-b", "implementation", 2, { branch: "feat" }),
      child("review", "review", 3),
    ];
    expect(match(children, { branch: "feat" })).toBeNull();
    expect(match(children)).toBeNull();
  });

  it("never links a reviewer started after the landing or one without the review role", () => {
    const children = [
      child("impl", "implementation", 1, { branch: "feat" }),
      child("late", "review", 59, { startedAt: "2026-11-20T12:00:00.000Z" }),
      child("helper", "research", 3, { prompt: "Look at feat." }),
      child("legacy", null, 4, { prompt: "Review feat." }),
    ];
    expect(match(children, { branch: "feat" })).toBeNull();
  });
});

describe("reviewVerdictFromText", () => {
  it.each([
    ["**Verdict: request changes.** Fix the race.", "changes_requested"],
    ["Verdict: approve.", "approved"],
    ["Verdict: approve with nits.", "approved"],
    ["**Verdict — ship-with-fixes.** Two findings.", "changes_requested"],
    ["Verdict: changes requested", "changes_requested"],
    ["Verdict: LGTM", "approved"],
    ["Round 1 verdict: request changes.\nRound 2 verdict: approved.", "approved"],
  ] as const)("reads %j as %s", (text, verdict) => {
    expect(reviewVerdictFromText(text)).toBe(verdict);
  });

  it.each([
    "Looks good to me.",
    "The verdict will follow once tests finish.",
    "Verdict: unclear until the benchmark runs.",
  ])("leaves %j undetermined", (text) => {
    expect(reviewVerdictFromText(text)).toBeNull();
  });
});
