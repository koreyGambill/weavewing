import {
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type ComposerContextRecord,
  type KnownComposerContextKind,
  type KnownComposerContextRecord,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";
import {
  collectComposerContextReferences,
  composerContextPayloadFields,
  type ComposerContextPayloadField,
} from "./composerContextReferences.ts";

/** One labelled piece of what a reference sent, such as a comment or the selected output. */
export interface SentContextSection {
  /** A short heading such as "Selector"; never searched. Null when the block's own header names it. */
  readonly label: string | null;
  /** Exactly the text the provider received for this field. */
  readonly text: string;
  /** Code, terminal output and markup keep their line breaks and render monospace. */
  readonly preformatted: boolean;
}

/**
 * The content a sent reference carried, as the timeline shows it under the message.
 * `display: "open"` blocks always show; `"expandable"` blocks open from their chip.
 */
export interface SentContextBlock {
  readonly contextId: string;
  readonly kind: KnownComposerContextKind;
  readonly label: string;
  readonly display: "open" | "expandable";
  readonly sections: readonly SentContextSection[];
  readonly record: KnownComposerContextRecord;
}

function shownSections(
  fields: ReadonlyArray<ComposerContextPayloadField>,
): SentContextSection[] {
  return fields.flatMap((field) =>
    field.children
      ? shownSections(field.children)
      : field.shown && field.value.trim()
        ? [{ label: field.shown.label, text: field.value, preformatted: field.shown.preformatted }]
        : [],
  );
}

/** The fields the provider received that the timeline shows; none for a label-only reference. */
export function sentContextSections(
  record: KnownComposerContextRecord,
): readonly SentContextSection[] {
  return shownSections(composerContextPayloadFields(record));
}

function blockFor(record: KnownComposerContextRecord): SentContextBlock | null {
  const sections = sentContextSections(record);
  if (sections.length === 0) return null;
  return {
    contextId: record.contextId,
    kind: record.kind,
    label: record.label,
    // What the user said answering a question is read without a click.
    display: record.kind === "artifact-answer" ? "open" : "expandable",
    sections,
    record,
  };
}

/**
 * The content a user message's references sent, in the order the text first references them.
 * Unknown kinds from a newer server and references without a record are skipped.
 */
export function sentContextBlocks(input: {
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
}): readonly SentContextBlock[] {
  if (input.records.length === 0) return [];
  const recordsById = new Map(input.records.map((record) => [record.contextId, record]));
  const seen = new Set<string>();
  const blocks: SentContextBlock[] = [];
  for (const occurrence of collectComposerContextReferences(input.text)) {
    if (seen.has(occurrence.contextId)) continue;
    seen.add(occurrence.contextId);
    const record = recordsById.get(occurrence.contextId);
    if (!record || "payload" in record) continue;
    const block = blockFor(record);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** The text and records a stored user message renders, upgrading messages from before records. */
export function sentMessageContext(message: {
  readonly text: string;
  readonly context?: Pick<OrchestrationMessageContext, "records"> | undefined;
}): { readonly text: string; readonly records: ReadonlyArray<ComposerContextRecord> } {
  return message.context
    ? { text: message.text, records: message.context.records }
    : upgradeLegacyContextMessage(message.text);
}

/**
 * Find's text for a user message's sent references, one segment per section in render order.
 * Section labels are not searched; line breaks outside preformatted text read as spaces.
 */
export function sentContextSearchSegments(message: {
  readonly text: string;
  readonly context?: Pick<OrchestrationMessageContext, "records"> | undefined;
}): readonly string[] {
  return sentContextBlocks(sentMessageContext(message)).flatMap((block) =>
    block.sections.map((entry) =>
      entry.preformatted ? entry.text : entry.text.replace(/\r?\n/g, " "),
    ),
  );
}

/** Whether `record` answers or comments on one of the thread's agent questions. */
export function threadQuestionReferenceMode(
  record: KnownComposerContextRecord,
): "answer" | "discuss" | null {
  if (record.kind !== "artifact-answer") return null;
  if (record.artifactId === THREAD_QUESTIONS_ARTIFACT_ID) return "answer";
  if (record.artifactId === THREAD_QUESTION_COMMENTS_ARTIFACT_ID) return "discuss";
  return null;
}
