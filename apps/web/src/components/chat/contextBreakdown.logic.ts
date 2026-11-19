import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

type BreakdownInput = Pick<
  ContextWindowSnapshot,
  | "usedTokens"
  | "maxTokens"
  | "autoCompactThreshold"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
>;

export interface ContextBreakdownRow {
  readonly label: string;
  readonly tokens: number;
  readonly percent: number | null;
}

const percentOf = (tokens: number, max: number) => Math.round((tokens / max) * 1000) / 10;

/**
 * How the context window divides between what is used, what is free, and the reserve the
 * provider keeps before compacting. Providers report totals, not a per-category breakdown.
 */
export function contextBreakdown(usage: BreakdownInput) {
  const max = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used = Math.max(0, usage.usedTokens);
  const threshold =
    max !== null && usage.autoCompactThreshold != null && usage.autoCompactThreshold < max
      ? usage.autoCompactThreshold
      : null;
  const rows: ContextBreakdownRow[] = [
    {
      label: "Used",
      tokens: used,
      percent: max === null ? null : percentOf(Math.min(used, max), max),
    },
  ];
  if (max !== null) {
    const reserve = threshold === null ? 0 : Math.max(0, Math.min(max - threshold, max - used));
    const free = Math.max(0, max - used - reserve);
    rows.push({ label: "Free", tokens: free, percent: percentOf(free, max) });
    if (threshold !== null) {
      rows.push({
        label: "Auto-compact reserve",
        tokens: reserve,
        percent: percentOf(reserve, max),
      });
    }
  }
  const kinds = (
    [
      ["Input", usage.inputTokens],
      ["Cached input", usage.cachedInputTokens],
      ["Output", usage.outputTokens],
      ["Reasoning", usage.reasoningOutputTokens],
    ] as const
  ).flatMap(([label, tokens]) => (tokens == null ? [] : [{ label, tokens }]));
  // Warn on the way to auto-compaction; without a threshold, fall back to how full the window is.
  const limit = threshold ?? max;
  const tone: "normal" | "warning" | "critical" =
    limit === null
      ? "normal"
      : used >= (threshold ?? limit * 0.9)
        ? "critical"
        : used >= (threshold === null ? limit * 0.8 : threshold * 0.9)
          ? "warning"
          : "normal";
  return {
    tone,
    usedTokens: used,
    maxTokens: max,
    usedPercent: max === null ? null : percentOf(Math.min(used, max), max),
    rows,
    kinds,
    compactsAtPercent: threshold === null || max === null ? null : percentOf(threshold, max),
  };
}
