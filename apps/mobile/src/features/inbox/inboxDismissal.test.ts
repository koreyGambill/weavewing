import { describe, expect, it, vi } from "vite-plus/test";

import { createInboxDismissal } from "./inboxDismissal";

function fakeTimers() {
  let pending: (() => void) | null = null;
  return {
    timers: {
      set: (run: () => void) => {
        pending = run;
        return 1;
      },
      clear: () => {
        pending = null;
      },
    },
    fire: () => pending?.(),
  };
}

describe("createInboxDismissal", () => {
  it("completes once from the fallback when the native callback is dropped", () => {
    const clock = fakeTimers();
    const dismissal = createInboxDismissal(clock.timers);
    const finish = vi.fn();

    dismissal.arm(finish);
    clock.fire();
    clock.fire();

    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("completes once when the native callback and the fallback both fire", () => {
    let queued: (() => void) | null = null;
    // A timer already queued on the event loop still runs after it is cleared.
    const dismissal = createInboxDismissal({
      set: (run) => {
        queued = run;
        return 1;
      },
      clear: () => {},
    });
    const finish = vi.fn();

    dismissal.arm(finish);
    dismissal.complete(finish);
    queued!();

    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("ignores a late native callback after the fallback finished", () => {
    const clock = fakeTimers();
    const dismissal = createInboxDismissal(clock.timers);
    const finish = vi.fn();

    dismissal.arm(finish);
    clock.fire();
    dismissal.complete(finish);

    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("never completes from a fallback disposed with the sheet", () => {
    const clock = fakeTimers();
    const dismissal = createInboxDismissal(clock.timers);
    const finish = vi.fn();

    dismissal.arm(finish);
    dismissal.dispose();
    clock.fire();

    expect(finish).not.toHaveBeenCalled();
  });
});
