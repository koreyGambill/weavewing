import { describe, expect, it } from "vite-plus/test";

import {
  resolveCenteredFileLineScrollTop,
  resolveFileLineRange,
  spanLineGeometry,
} from "./fileLineReveal";

describe("resolveCenteredFileLineScrollTop", () => {
  it("corrects a stale estimate from the rendered line geometry", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 830,
        scrollHeight: 2_000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1_000, height: 20 },
        renderedLine: { top: 620, height: 20 },
      }),
    ).toBe(1_160);
  });

  it("centers a range that fits and aligns a taller one to its first line", () => {
    const scroll = (lines: { top: number; height: number }) =>
      resolveCenteredFileLineScrollTop({
        scrollTop: 0,
        scrollHeight: 10_000,
        viewportTop: 0,
        viewportHeight: 400,
        fileTop: 0,
        estimatedLine: lines,
      });
    const range = spanLineGeometry({ top: 1_120, height: 20 }, { top: 1_260, height: 20 });
    expect(range).toEqual({ top: 1_120, height: 160 });
    expect(scroll(range)).toBe(1_120 - 120);
    expect(scroll(spanLineGeometry({ top: 1_120, height: 20 }, { top: 2_000, height: 20 }))).toBe(
      1_120,
    );
  });
});

describe("resolveFileLineRange", () => {
  const contents = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");

  it("keeps a range inside the file", () => {
    expect(resolveFileLineRange(contents, 57, 64)).toEqual({ start: 57, end: 64 });
    expect(resolveFileLineRange(contents, 95, 140)).toEqual({ start: 95, end: 100 });
    expect(resolveFileLineRange(contents, 140, 150)).toEqual({ start: 100, end: 100 });
  });

  it("selects a single line without an end or with an end before the start", () => {
    expect(resolveFileLineRange(contents, 57, null)).toEqual({ start: 57, end: 57 });
    expect(resolveFileLineRange(contents, 57, 12)).toEqual({ start: 57, end: 57 });
  });

  it("counts CRLF and lone CR line endings once each", () => {
    expect(resolveFileLineRange("a\r\nb\rc", 1, 9)).toEqual({ start: 1, end: 3 });
  });
});
