import { GitCommandError, type WorktreeProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";

/** Why this machine refuses a T3 worktree, and what an agent or user should do instead. */
export const worktreeProviderRefusal = (provider: Exclude<WorktreeProvider, "t3">): string =>
  provider === "xwing"
    ? "T3 worktrees are disabled by the `worktreeProvider` server setting (xwing); isolated work uses Xwing environments. Launch a thread with `workspaceStrategy: {type: 'worktree'}` to get a new Xwing environment, or pick one from `t3_xwing_environment_list` and pass `workspaceStrategy: {type: 'xwing_environment', xwingEnvironmentId}`."
    : "T3 worktrees are disabled by the `worktreeProvider` server setting (off). Work in the project checkout, or ask the user to change Settings → Worktrees.";

/** An unreadable settings file keeps the default, as other worktree settings do. */
export const readWorktreeProvider = (settings: ServerSettings.ServerSettingsService["Service"]) =>
  settings.getSettings.pipe(
    Effect.map((current) => current.worktreeProvider),
    Effect.orElseSucceed((): WorktreeProvider => "t3"),
  );

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
