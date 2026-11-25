import { describe, expect, it } from "vite-plus/test";

import { compactListKeyTarget } from "./ThreadQuestionsCompactList.logic";

describe("compactListKeyTarget", () => {
  const ids = ["Q1", "Q4", "Q7"];
  it.each([
    ["ArrowDown", null, "Q1"],
    ["ArrowDown", "Q1", "Q4"],
    ["ArrowDown", "Q7", "Q7"],
    ["ArrowUp", null, "Q1"],
    ["ArrowUp", "Q4", "Q1"],
    ["ArrowUp", "Q1", "Q1"],
    ["Home", "Q7", "Q1"],
    ["End", "Q1", "Q7"],
    // A row that left the list starts again from the top.
    ["ArrowDown", "Q9", "Q1"],
    ["Enter", "Q1", null],
  ] as const)("moves %s from %s to %s", (key, active, target) => {
    expect(compactListKeyTarget(key, ids, active)).toBe(target);
  });

  it("moves nowhere in an empty list", () => {
    expect(compactListKeyTarget("ArrowDown", [], null)).toBeNull();
  });
});
