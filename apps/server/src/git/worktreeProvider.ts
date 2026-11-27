import { GitCommandError, type WorktreeProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";

/** Why this machine refuses a T3 worktree, and what an agent or user should do instead. */
export const worktreeProviderRefusal = (provider: Exclude<WorktreeProvider, "t3">): string =>
  provider === "xwing"
    ? "T3 worktrees are disabled by the `worktreeProvider` server setting (xwing); isolated work uses Xwing environments. Launch a thread with `workspaceStrategy: {type: 'worktree'}` to get a new Xwing environment, or pick one from `t3_xwing_environment_list` and pass `workspaceStrategy: {type: 'xwing_environment', xwingEnvironmentId}`."
    : "T3 worktrees are disabled by the `worktreeProvider` server setting (off). Work in the project checkout, or ask the user to change Settings → Worktrees.";

export const readWorktreeProvider = (settings: ServerSettings.ServerSettingsService["Service"]) =>
  settings.worktreeProvider;

/** Fails unless this machine lets T3 create worktrees. */
export const requireT3Worktrees = Effect.fn("worktreeProvider.requireT3Worktrees")(function* (
  settings: ServerSettings.ServerSettingsService["Service"],
  operation: string,
  cwd: string,
) {
  const provider = yield* readWorktreeProvider(settings);
  if (provider === "t3") return;
  return yield* new GitCommandError({
    operation,
    command: "git worktree add",
    cwd,
    detail: worktreeProviderRefusal(provider),
  });
});

/** Refusal for paths that recover or roll back a T3 worktree; its message names the setting. */
export class WorktreeProviderDisabledError extends Schema.TaggedError<WorktreeProviderDisabledError>()(
  "WorktreeProviderDisabledError",
  {
    operation: Schema.String,
    worktreeProvider: Schema.Literals(["xwing", "off"]),
    /** The missing worktree's branch, which survives in the project repository. */
    branch: Schema.String,
  },
) {
  override get message(): string {
    if (this.worktreeProvider === "off") return worktreeProviderRefusal("off");
    // `git worktree add` refuses a branch still registered to the deleted worktree.
    return `This thread's T3 worktree is missing, and the \`worktreeProvider\` server setting (xwing) disables T3 worktrees, so it was not recreated. Its branch '${this.branch}' remains in the project repository. To continue it in a new Xwing environment, run \`git worktree prune\` in the project, then launch a thread with \`workspaceStrategy: {type: 'worktree', baseRef: <default branch>, branch: '${this.branch}'}\`.`;
  }
}

export const refuseUnlessT3Worktrees = Effect.fn("worktreeProvider.refuseUnlessT3Worktrees")(
  function* (
    settings: ServerSettings.ServerSettingsService["Service"],
    operation: string,
    branch: string,
  ) {
    const worktreeProvider = yield* readWorktreeProvider(settings);
    if (worktreeProvider === "t3") return;
    return yield* new WorktreeProviderDisabledError({ operation, worktreeProvider, branch });
  },
);
