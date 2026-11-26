import { qaCardTitle, qaKey, qaRef, type QaChange } from "@t3tools/client-runtime/qa-card";
import type { EvidenceLanding, WaitingItemContextRecord } from "@t3tools/contracts";

import { waitingItemDiscussRecord } from "../waiting/waitingItemComposer";

/** The Discuss reference for one QA change, labelled `QA3 · discuss · <title>`. */
export function qaDiscussRecord(
  landing: Pick<EvidenceLanding, "id" | "target">,
  change: QaChange,
): WaitingItemContextRecord {
  return waitingItemDiscussRecord({
    itemKind: "qa",
    key: qaKey(landing.id, change.id),
    ref: qaRef(change),
    title: qaCardTitle(change),
    sha: landing.target.sha,
  });
}
