import { describe, expect, it } from "vite-plus/test";
import { deletionRange, lineBoundary, lineMoveForKey } from "./lineEditing";

describe("line editing", () => {
  it.each([
    ["lineStart", 9, 9, 6, 9],
    ["lineEnd", 9, 9, 9, 16],
    ["wordBack", 9, 9, 6, 9],
    ["wordForward", 6, 6, 6, 9],
    ["lineStart", 2, 4, 2, 4],
  ] as const)("deletes %s from %i to %i", (kind, start, end, from, to) => {
    expect(deletionRange("first\none two xx", start, end, kind)).toEqual([from, to]);
  });

  it("moves to the line's ends with Ctrl+Arrow outside macOS", () => {
    const key = (key: string, ctrlKey = true) =>
      ({ key, ctrlKey, altKey: false, metaKey: false, isComposing: false }) as const;
    expect(lineMoveForKey(key("ArrowLeft"), false)).toBe("lineStart");
    expect(lineMoveForKey(key("ArrowRight"), false)).toBe("lineEnd");
    expect(lineMoveForKey(key("ArrowLeft"), true)).toBeNull();
    expect(lineMoveForKey(key("ArrowLeft", false), false)).toBeNull();
    expect(lineBoundary("first\none two xx", 9, "lineStart")).toBe(6);
    expect(lineBoundary("first\none two xx", 2, "lineEnd")).toBe(5);
  });
});
