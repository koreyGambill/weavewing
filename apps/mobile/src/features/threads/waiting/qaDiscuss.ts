import { useAtomValue } from "@effect/atom-react";
import type { WaitingItemContextRecord } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

import {
  composerDraftsAtom,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftText,
} from "../../../state/use-composer-drafts";

/** The QA keys whose Discuss reference the thread's composer draft holds. */
export function useQaKeysInComposer(draftKey: string | null): ReadonlySet<string> {
  const draft = useAtomValue(composerDraftsAtom, (drafts) =>
    draftKey === null ? undefined : drafts[draftKey],
  );
  if (draft?.context === undefined) return new Set();
  const referenced = new Set(collectComposerContextReferences(draft.text).map((r) => r.contextId));
  return new Set(
    draft.context.records.flatMap((record) =>
      record.kind === "waiting-item" &&
      "itemKind" in record &&
      record.itemKind === "qa" &&
      referenced.has(record.contextId)
        ? [record.key]
        : [],
    ),
  );
}

/** Appends the change's Discuss reference to the draft; false when the draft has no room. */
export function addQaDiscuss(draftKey: string, record: WaitingItemContextRecord): boolean {
  const draft = getComposerDraftSnapshot(draftKey);
  return insertComposerDraftContext(
    draftKey,
    { text: formatComposerContextReference(record), context: { version: 1, records: [record] } },
    { text: draft.text, start: draft.text.length, end: draft.text.length },
  );
}

/** Takes the change's Discuss reference out of the draft; the draft drops the unreferenced record. */
export function removeQaDiscuss(draftKey: string, record: WaitingItemContextRecord) {
  const { text } = getComposerDraftSnapshot(draftKey);
  const next = replaceComposerContextReferences(text, (occurrence) =>
    occurrence.contextId === record.contextId ? "" : text.slice(occurrence.start, occurrence.end),
  );
  if (next !== text) setComposerDraftText(draftKey, next);
}
