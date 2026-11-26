import { isThreadQuestionRecord } from "@t3tools/client-runtime/state/thread-questions";
import type {
  ArtifactAnswerContextRecord,
  ComposerContextRecord,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

interface DraftContent {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}

const isArtifactAnswer = (record: ComposerContextRecord): record is ArtifactAnswerContextRecord =>
  record.kind === "artifact-answer" && !("payload" in record);

/** The question answers and discussions a draft's context carries, in order. */
export function composerQuestionRecords(
  context: OrchestrationMessageContext | undefined,
): ArtifactAnswerContextRecord[] {
  return (context?.records ?? []).filter(
    (record): record is ArtifactAnswerContextRecord =>
      isArtifactAnswer(record) && isThreadQuestionRecord(record),
  );
}

/** `text` without the references to `contextIds`, each with the space beside it. */
function withoutReferences(text: string, contextIds: ReadonlySet<string>): string {
  let result = text;
  const occurrences = collectComposerContextReferences(text).filter((occurrence) =>
    contextIds.has(occurrence.contextId),
  );
  for (const occurrence of occurrences.reverse()) {
    let { start, end } = occurrence;
    if (result[end] === " ") end += 1;
    else if (result[start - 1] === " ") start -= 1;
    result = result.slice(0, start) + result.slice(end);
    // A reference that ended the text takes the whitespace before it too.
    if (start >= result.length) result = result.trimEnd();
  }
  return result;
}

/**
 * A draft whose question records are exactly `next`: a record that left loses its reference, a
 * record whose context id stays is replaced in place, and a new one is referenced at the end of
 * the text. Other context is untouched. Null when nothing changed.
 */
export function withComposerQuestionRecords(
  draft: DraftContent,
  next: ReadonlyArray<ArtifactAnswerContextRecord>,
): { readonly text: string; readonly context: OrchestrationMessageContext | undefined } | null {
  const current = composerQuestionRecords(draft.context);
  const nextById = new Map(next.map((record) => [record.contextId, record]));
  const currentIds = new Set(current.map((record) => record.contextId));
  const removed = new Set(
    current.flatMap((record) => (nextById.has(record.contextId) ? [] : [record.contextId])),
  );
  const added = next.filter((record) => !currentIds.has(record.contextId));
  const replaced = current.some((record) => {
    const fresh = nextById.get(record.contextId);
    return fresh !== undefined && fresh !== record;
  });
  if (removed.size === 0 && added.length === 0 && !replaced) return null;

  let text = withoutReferences(draft.text, removed);
  for (const record of added) {
    text += `${text.length > 0 && !/\s$/.test(text) ? " " : ""}${formatComposerContextReference(record)} `;
  }
  const records = [
    ...(draft.context?.records ?? []).flatMap((record) => {
      if (removed.has(record.contextId)) return [];
      return [nextById.get(record.contextId) ?? record];
    }),
    ...added,
  ];
  return { text, context: records.length > 0 ? { version: 1, records } : undefined };
}
