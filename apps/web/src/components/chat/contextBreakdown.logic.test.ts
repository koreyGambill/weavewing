import { describe, expect, it } from "vite-plus/test";

import { contextBreakdown } from "./contextBreakdown.logic";

const usage = (fields: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null;
  readonly autoCompactThreshold?: number | null;
  readonly inputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly reasoningOutputTokens?: number | null;
}) => ({
  usedTokens: fields.usedTokens,
  maxTokens: fields.maxTokens ?? null,
  autoCompactThreshold: fields.autoCompactThreshold ?? null,
  inputTokens: fields.inputTokens ?? null,
  cachedInputTokens: fields.cachedInputTokens ?? null,
  outputTokens: fields.outputTokens ?? null,
  reasoningOutputTokens: fields.reasoningOutputTokens ?? null,
});

describe("contextBreakdown", () => {
  it("splits the window into used, free and the auto-compact reserve", () => {
    expect(
      contextBreakdown(
        usage({ usedTokens: 200_000, maxTokens: 1_000_000, autoCompactThreshold: 900_000 }),
      ),
    ).toMatchObject({
      usedPercent: 20,
      rows: [
        { label: "Used", tokens: 200_000, percent: 20 },
        { label: "Free", tokens: 700_000, percent: 70 },
        { label: "Auto-compact reserve", tokens: 100_000, percent: 10 },
      ],
      compactsAtPercent: 90,
    });
  });

  it("shrinks the reserve once usage runs into it, and never goes negative", () => {
    expect(
      contextBreakdown(
        usage({ usedTokens: 950_000, maxTokens: 1_000_000, autoCompactThreshold: 900_000 }),
      ).rows,
    ).toEqual([
      { label: "Used", tokens: 950_000, percent: 95 },
      { label: "Free", tokens: 0, percent: 0 },
      { label: "Auto-compact reserve", tokens: 50_000, percent: 5 },
    ]);
  });

  it("reports only used tokens when the window size is unknown", () => {
    expect(contextBreakdown(usage({ usedTokens: 1_234 }))).toMatchObject({
      usedPercent: null,
      rows: [{ label: "Used", tokens: 1_234, percent: null }],
      compactsAtPercent: null,
    });
  });

  it("lists only the token kinds the provider reported", () => {
    expect(
      contextBreakdown(
        usage({
          usedTokens: 10,
          maxTokens: 100,
          inputTokens: 8,
          outputTokens: 2,
          cachedInputTokens: 0,
        }),
      ).kinds,
    ).toEqual([
      { label: "Input", tokens: 8 },
      { label: "Cached input", tokens: 0 },
      { label: "Output", tokens: 2 },
    ]);
  });
});
