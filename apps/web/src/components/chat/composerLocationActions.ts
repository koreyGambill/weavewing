import { createContext, use } from "react";

/**
 * Actions the row's location menu offers beside Change folder, supplied by the row that owns the
 * controls behind them. An absent action is not offered.
 */
export interface ComposerLocationActions {
  /** Opens the Xwing environment chooser anchored to the location, returning focus there. */
  readonly chooseXwingEnvironment?: ((anchor: HTMLElement) => void) | undefined;
  /** Opens the dialog that creates an Xwing environment and moves the thread into it. */
  readonly newEnvironment?: (() => void) | undefined;
  /**
   * Opens the dialog that moves the thread into a new worktree or Xwing environment on a new
   * branch, returning focus to `returnFocus` when it closes.
   */
  readonly handoffWorktree?: ((returnFocus: HTMLElement | null) => void) | undefined;
}

export const ComposerLocationActionsContext = createContext<ComposerLocationActions>({});

export function useComposerLocationActions(): ComposerLocationActions {
  return use(ComposerLocationActionsContext);
}
