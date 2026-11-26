import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { bulkDismissDraftFor, useBulkDismissStore } from "./bulkDismissStore";

const first = "env-1" as EnvironmentId;
const second = "env-2" as EnvironmentId;

describe("bulk dismissal drafts", () => {
  it("keeps each environment's draft to itself and never opens it in another", () => {
    // The second environment has a draft of its own from earlier.
    useBulkDismissStore.getState().start(second);
    useBulkDismissStore.getState().close();
    useBulkDismissStore.getState().start(first);
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
    // An environment never opened has no draft to edit.
    const third = "env-3" as EnvironmentId;
    useBulkDismissStore.getState().edit(third, { reason: "stray" });
    expect(useBulkDismissStore.getState().drafts[third]).toBeUndefined();
  });
});
