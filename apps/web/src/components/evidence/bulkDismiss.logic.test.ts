import { describe, expect, it } from "vite-plus/test";

import { bulkDismissBefore, localDateInputValue } from "./bulkDismiss.logic";

describe("bulkDismissBefore", () => {
  it("stops at the start of the chosen local day", () => {
    const before = bulkDismissBefore("2026-11-25");
    expect(before).toBe(new Date(2026, 10, 25).toISOString());
    expect(localDateInputValue(new Date(before!))).toBe("2026-11-25");
  });

  it("refuses an empty or impossible day", () => {
    expect(bulkDismissBefore("")).toBeNull();
    expect(bulkDismissBefore("2026-02-30")).toBeNull();
  });
});
