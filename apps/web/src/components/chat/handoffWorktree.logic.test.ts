import { WorktreeMcpFailure } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  handoffBranchNameProblem,
  handoffFailureMessage,
  handoffSuccessToast,
} from "./handoffWorktree.logic";

describe("handoffBranchNameProblem", () => {
  it("accepts names Git accepts", () => {
    for (const name of ["feature/retry-count", "release-1.2", "fix_toast", "a/b/c"]) {
      expect(handoffBranchNameProblem(name), name).toBeNull();
    }
  });

  it("names what Git would refuse", () => {
    expect(handoffBranchNameProblem("")).toBe("Enter a name for the new branch.");
    expect(handoffBranchNameProblem("retry count")).toMatch(/spaces/);
    expect(handoffBranchNameProblem("-retry")).toMatch(/dash/);
    for (const name of ["a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\u0007b"]) {
      expect(handoffBranchNameProblem(name), name).toMatch(/cannot contain ~/);
    }
    expect(handoffBranchNameProblem("a..b")).toMatch(/two dots/);
    expect(handoffBranchNameProblem("a@{b")).toMatch(/@\{/);
    expect(handoffBranchNameProblem("@")).toMatch(/@\{/);
    for (const name of ["/a", "a/", "a//b"]) {
      expect(handoffBranchNameProblem(name), name).toMatch(/slash/);
    }
    expect(handoffBranchNameProblem("a.")).toMatch(/end with a dot/);
    expect(handoffBranchNameProblem("a/.b")).toMatch(/start with a dot/);
    expect(handoffBranchNameProblem("a.lock")).toMatch(/\.lock/);
  });
});

describe("handoffFailureMessage", () => {
  it("shows the server's reason", () => {
    const failure = new WorktreeMcpFailure({
      code: "invalid_request",
      message: "Branch 'main' already exists. Choose a different branch name.",
    });
    expect(handoffFailureMessage(Cause.fail(failure))).toBe(failure.message);
  });
});

describe("handoffSuccessToast", () => {
  const result = {
    worktreePath: "/worktrees/render/feature/toast",
    baseRef: "main",
    startedFromOrigin: true,
    setupScript: { status: "no-script" as const },
  };

  it("names the worktree when everything went as chosen", () => {
    expect(handoffSuccessToast(result, { startFromOrigin: true })).toEqual({
      type: "success",
      title: "Handed off to a worktree",
      description: "/worktrees/render/feature/toast",
    });
  });

  it("says when the remote was asked for but the local commit was used", () => {
    const toast = handoffSuccessToast(
      { ...result, startedFromOrigin: false },
      { startFromOrigin: true },
    );
    expect(toast.type).toBe("warning");
    expect(toast.description).toContain(
      "No remote held main, so it started from the local commit.",
    );
    // Not asking for the remote is not a fallback.
    expect(
      handoffSuccessToast({ ...result, startedFromOrigin: false }, { startFromOrigin: false }).type,
    ).toBe("success");
  });

  it("says when the setup script failed", () => {
    const toast = handoffSuccessToast(
      { ...result, setupScript: { status: "failed", detail: "vp install exited 1" } },
      { startFromOrigin: true },
    );
    expect(toast.type).toBe("warning");
    expect(toast.description).toContain("The setup script failed: vp install exited 1");
  });
});
