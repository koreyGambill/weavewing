declare global {
  // The SEA bootstrap and embedded CLI are separate bundles in the same process.
  var __t3StartupTimings: Array<{ phase: string; at: number }> | undefined;
}

const timings = (globalThis.__t3StartupTimings ??= [{ phase: "process.entry", at: Date.now() }]);

export function recordStartupTiming(phase: string): void {
  timings.push({ phase, at: Date.now() });
}

export function readStartupTimings() {
  return [...timings];
}
