import { describe, expect, it } from "vite-plus/test";

import { findTerminalMatches, initialTerminalMatchIndex, stepTerminalMatchIndex } from "./find";

describe("findTerminalMatches", () => {
  it("matches case-insensitively, literally, and per row", () => {
    expect(findTerminalMatches(["Error: a.b", "", "no error", "a+b ERROR error"], "error")).toEqual(
      [
        { row: 0, start: 0, end: 5 },
        { row: 2, start: 3, end: 8 },
        { row: 3, start: 4, end: 9 },
        { row: 3, start: 10, end: 15 },
      ],
    );
    expect(findTerminalMatches(["a.b axb", "a+b"], "a.b")).toEqual([{ row: 0, start: 0, end: 3 }]);
    expect(findTerminalMatches(["a+b"], "a+b")).toEqual([{ row: 0, start: 0, end: 3 }]);
    expect(findTerminalMatches(["anything"], "")).toEqual([]);
  });

  it("reports UTF-16 offsets after astral characters", () => {
    expect(findTerminalMatches(["🙂 ok"], "ok")).toEqual([{ row: 0, start: 3, end: 5 }]);
  });
});

describe("terminal match navigation", () => {
  const matches = [
    { row: 2, start: 0, end: 1 },
    { row: 10, start: 0, end: 1 },
    { row: 30, start: 0, end: 1 },
  ];

  it("starts at the first match the viewport shows or below, else the last match", () => {
    expect(initialTerminalMatchIndex(matches, 0)).toBe(0);
    expect(initialTerminalMatchIndex(matches, 5)).toBe(1);
    expect(initialTerminalMatchIndex(matches, 40)).toBe(2);
    expect(initialTerminalMatchIndex([], 0)).toBe(-1);
  });

  it("wraps in both directions", () => {
    expect(stepTerminalMatchIndex(3, 2, true)).toBe(0);
    expect(stepTerminalMatchIndex(3, 0, false)).toBe(2);
    expect(stepTerminalMatchIndex(3, -1, false)).toBe(2);
    expect(stepTerminalMatchIndex(0, 0, true)).toBe(-1);
  });
});
