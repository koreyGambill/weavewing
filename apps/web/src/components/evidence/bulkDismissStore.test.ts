import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { bulkDismissDraftFor, useBulkDismissStore } from "./bulkDismissStore";

const first = "env-1" as EnvironmentId;
const second = "env-2" as EnvironmentId;

describe("bulk dismissal drafts", () => {
  it("keeps each environment's draft to itself and never opens it in another", () => {
    const store = useBulkDismissStore.getState();
    store.start(first);
    useBulkDismissStore.getState().edit(first, { day: "2026-11-01", reason: "old backlog" });
    useBulkDismissStore.getState().close();
    // Closed in the first environment, then the user switches: nothing opens in the second.
    expect(bulkDismissDraftFor(useBulkDismissStore.getState(), second)).toBeNull();
    expect(bulkDismissDraftFor(useBulkDismissStore.getState(), first)).toBeNull();

    useBulkDismissStore.getState().start(first);
    useBulkDismissStore.getState().edit(first, { day: "2026-11-01", reason: "old backlog" });
    // Open in the first environment: the second sees no draft, and the first keeps its own.
    expect(bulkDismissDraftFor(useBulkDismissStore.getState(), second)).toBeNull();
    expect(bulkDismissDraftFor(useBulkDismissStore.getState(), first)).toEqual({
      day: "2026-11-01",
      reason: "old backlog",
    });
    // Editing a draft that was never opened in the second environment changes nothing.
    useBulkDismissStore.getState().edit(second, { reason: "stray" });
    expect(useBulkDismissStore.getState().drafts[second]).toBeUndefined();
  });
});
