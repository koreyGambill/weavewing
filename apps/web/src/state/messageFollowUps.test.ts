import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { debouncedReturnSignal } from "./messageFollowUps";

it("ticks once for a burst of window-return events", () => {
  vi.useFakeTimers();
  using timers = new DisposableStack();
  timers.defer(() => vi.useRealTimers());
  let wake = () => {};
  const signal = debouncedReturnSignal((listener) => {
    wake = listener;
    return () => {};
  }, 250);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(signal);
  const initial = registry.get(signal);

  wake();
  wake();
  vi.advanceTimersByTime(249);
  expect(registry.get(signal)).toBe(initial);
  vi.advanceTimersByTime(1);
  const afterReturn = registry.get(signal);
  expect(afterReturn).not.toBe(initial);
  vi.advanceTimersByTime(1_000);
  expect(registry.get(signal)).toBe(afterReturn);
  unmount();
});
