const prefix = "t3code.startup.";
if (performance.getEntriesByName(`${prefix}process.entry`).length === 0) {
  performance.mark(`${prefix}process.entry`);
}

export function recordStartupTiming(phase: string): void {
  performance.mark(`${prefix}${phase}`);
}

export function readStartupTimings() {
  return performance
    .getEntriesByType("mark")
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => ({
      phase: entry.name.slice(prefix.length),
      at: performance.timeOrigin + entry.startTime,
    }));
}
