import { describe, expect, it } from "vite-plus/test";
import { sectionSidebarFamilies } from "./sidebarGroupBy.logic";

describe("sectionSidebarFamilies", () => {
  it("sections by each family's head in first-seen order and keeps forks with their head", () => {
    const sectionOf = (key: string) => {
      const machine = key.split(":")[0]!;
      return { key: machine, label: machine.toUpperCase() };
    };
    const sections = sectionSidebarFamilies([["b:1", "a:fork"], ["a:2"], ["b:3"]], sectionOf);
    expect(sections).toEqual([
      { key: "b", label: "B", items: ["b:1", "a:fork", "b:3"] },
      { key: "a", label: "A", items: ["a:2"] },
    ]);
  });
});
