interface DismissalTimers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const SYSTEM_TIMERS: DismissalTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Past the sheet's dismissal animation, the same bound the command palette uses. */
export const INBOX_DISMISS_FALLBACK_MS = 400;

/**
 * Finishes a sheet's dismissal exactly once. iOS can drop a sheet's dismissal callback, so a
 * programmatic close also arms a bounded fallback; whichever of the two comes first completes,
 * and the other does nothing.
 */
export function createInboxDismissal(timers: DismissalTimers = SYSTEM_TIMERS) {
  let done = false;
  let timer: unknown = null;
  const stop = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const complete = (run: () => void) => {
    stop();
    if (done) return;
    done = true;
    run();
  };
  return {
    /** The native dismissal callback. */
    complete,
    /** Completes after the bound unless the native callback comes first. */
    arm: (run: () => void, ms = INBOX_DISMISS_FALLBACK_MS) => {
      stop();
      timer = timers.set(() => complete(run), ms);
    },
    dispose: stop,
  };
}
