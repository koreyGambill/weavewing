import { describe, expect, it } from "vite-plus/test";

import { bulkDismissBefore, bulkDismissOutcome, localDateInputValue } from "./bulkDismiss.logic";

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

describe("bulkDismissOutcome", () => {
  it("reports what it dismissed and what had changed, without naming its state", () => {
    expect(bulkDismissOutcome(3, 3)).toBe("Dismissed 3 changes.");
    expect(bulkDismissOutcome(1, 1)).toBe("Dismissed 1 change.");
    expect(bulkDismissOutcome(3, 2)).toBe(
      "Dismissed 2 changes. 1 had already changed and was left as it is.",
    );
    expect(bulkDismissOutcome(5, 2)).toBe(
      "Dismissed 2 changes. 3 had already changed and were left as they are.",
    );
  });
});
