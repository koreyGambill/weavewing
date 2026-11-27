import type { WorktreeMcpHandoffResult, WorktreeProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

/**
 * Why Git would refuse `name` as a new branch, or null when it would accept it. Covers the
 * rules of `git check-ref-format --branch` a person is likely to hit; the server checks the rest,
 * such as a name that is already taken.
 */
export function handoffBranchNameProblem(name: string): string | null {
  if (name === "") return "Enter a name for the new branch.";
  if (/\s/.test(name)) return "A branch name cannot contain spaces.";
  if (name.startsWith("-")) return "A branch name cannot start with a dash.";
  if (/[\u0000-\u001f\u007f~^:?*[\\]/.test(name)) {
    return "A branch name cannot contain ~ ^ : ? * [ \\ or control characters.";
  }
  if (name.includes("..")) return "A branch name cannot contain two dots in a row.";
  if (name.includes("@{") || name === "@") return "A branch name cannot be @ or contain @{.";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "A branch name cannot start or end with a slash, or have two in a row.";
  }
  if (name.endsWith(".")) return "A branch name cannot end with a dot.";
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return "No part of a branch name can start with a dot or end with .lock.";
  }
  return null;
}

/** Where a handoff moves the thread on a server with this `worktreeProvider`. */
export function handoffDestination(worktreeProvider: WorktreeProvider): string {
  return worktreeProvider === "xwing" ? "an Xwing environment" : "a worktree";
}

/** The server's reason a handoff failed, to show beside the branch name. */
export function handoffFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message !== ""
    ? error.message
    : "The handoff failed. Try again.";
}

/**
 * The success toast, which also says when an option the person chose did not happen as asked:
 * the setup script failed, or no remote held the base so the checkout started from the local
 * commit.
 */
export function handoffSuccessToast(
  result: Pick<
    WorktreeMcpHandoffResult,
    "worktreePath" | "baseRef" | "startedFromOrigin" | "setupScript"
  >,
  requested: { readonly startFromOrigin: boolean; readonly destination: string },
) {
  const notes = [
    requested.startFromOrigin && !result.startedFromOrigin
      ? `No remote held ${result.baseRef}, so it started from the local commit.`
      : null,
    result.setupScript.status === "failed"
      ? `The setup script failed: ${result.setupScript.detail}`
      : null,
  ].filter((note) => note !== null);
  return {
    type: notes.length > 0 ? ("warning" as const) : ("success" as const),
    title: `Handed off to ${requested.destination}`,
    description: [result.worktreePath, ...notes].join("\n"),
  };
}
