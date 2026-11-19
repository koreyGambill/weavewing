import { describe, expect, it } from "vite-plus/test";
import { deletionRange } from "./lineEditing";

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
});
