import {
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  type ArtifactAnswerContextRecord,
  type ComposerContextRecord,
  type ElementContextDetails,
  type KnownComposerContextKind,
  type KnownComposerContextRecord,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";
import { collectComposerContextReferences } from "./composerContextReferences.ts";

/** One labelled piece of what a reference sent, such as a comment or the selected output. */
export interface SentContextSection {
  /** A short heading such as "Selector"; never searched. Null when the block's own header names it. */
  readonly label: string | null;
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

type Expansion<K extends KnownComposerContextKind> = {
  readonly display: "open" | "expandable";
  readonly sections: (
    record: Extract<KnownComposerContextRecord, { kind: K }>,
  ) => ReadonlyArray<SentContextSection | null>;
};

const section = (
  label: string | null,
  text: string | null | undefined,
  preformatted = false,
): SentContextSection | null => {
  const value = preformatted ? (text ?? "").replace(/^\n+|\s+$/g, "") : (text ?? "").trim();
  return value ? { label, text: value, preformatted } : null;
};

function sourceLocation(element: ElementContextDetails): string | null {
  const source = element.source;
  if (!source?.fileName) return null;
  if (source.lineNumber === null) return source.fileName;
  return `${source.fileName}:${source.lineNumber}${source.columnNumber === null ? "" : `:${source.columnNumber}`}`;
}

function elementSections(element: ElementContextDetails, prefix = "") {
  return [
    section(`${prefix}Selector`, element.selector || `<${element.tagName}>`),
    section(`${prefix}Component`, element.componentName),
    section(`${prefix}Source`, sourceLocation(element)),
    section(`${prefix}HTML`, element.htmlPreview, true),
    section(`${prefix}Styles`, element.styles, true),
  ];
}

/** A question answer or comment: what was asked, what was chosen and what the user wrote. */
function artifactAnswerSections(
  record: ArtifactAnswerContextRecord,
): readonly SentContextSection[] {
  const comment = record.artifactId === THREAD_QUESTION_COMMENTS_ARTIFACT_ID;
  return [
    section(null, record.question),
    comment ? null : section("Answer", record.choice),
    section(comment ? "Comment" : "Note", record.note),
  ].filter((entry) => entry !== null);
}

/**
 * Every kind's sent content. A kind with nothing beyond its chip label returns no sections, so
 * its chip gets no expand control. Adding a kind to `COMPOSER_CONTEXT_KINDS` requires an entry.
 */
const SENT_CONTEXT_EXPANSIONS: { readonly [K in KnownComposerContextKind]: Expansion<K> } = {
  "artifact-answer": { display: "open", sections: artifactAnswerSections },
  terminal: {
    display: "expandable",
    sections: (record) => [
      section(
        `${record.terminalLabel}, lines ${record.lineStart}–${record.lineEnd}`,
        record.text,
        true,
      ),
    ],
  },
  element: {
    display: "expandable",
    sections: (record) => [
      section("Page", record.pageTitle),
      section("URL", record.pageUrl),
      ...elementSections(record),
    ],
  },
  "preview-annotation": {
    display: "expandable",
    sections: (record) => [
      section("Page", record.pageTitle),
      section("URL", record.pageUrl),
      section("Comment", record.comment),
      section("Targets", record.targetSummary),
      section("Requested changes", record.styleChanges.join("\n"), true),
      ...(record.elements ?? []).flatMap((element, index) =>
        elementSections(element, (record.elements?.length ?? 0) > 1 ? `Element ${index + 1} ` : ""),
      ),
    ],
  },
  "review-comment": {
    display: "expandable",
    sections: (record) => [
      section(
        "Pull request",
        record.pullRequest
          ? `#${record.pullRequest.number} ${record.pullRequest.title} (${record.pullRequest.headBranch} into ${record.pullRequest.baseBranch})`
          : null,
      ),
      section("File", record.filePath.startsWith("artifact:") ? null : record.filePath),
      section("Range", `${record.sectionTitle} · ${record.rangeLabel}`),
      section("Comment", record.text),
      section(record.fenceLanguage ?? "Diff", record.diff, true),
    ],
  },
  response: {
    display: "expandable",
    sections: (record) => [
      section("Subagents", record.subagents?.map((subagent) => subagent.title).join(", ")),
      section("Replying to", record.citation.text),
      section("Comment", record.citation.comment),
    ],
  },
  thread: { display: "expandable", sections: (record) => [section("Title", record.title)] },
  image: { display: "expandable", sections: () => [] },
  file: { display: "expandable", sections: () => [] },
  mention: { display: "expandable", sections: () => [] },
  skill: { display: "expandable", sections: () => [] },
  environment: { display: "expandable", sections: () => [] },
};

function blockFor(record: KnownComposerContextRecord): SentContextBlock | null {
  // Each entry takes its own kind's record; the lookup by `record.kind` keeps them paired.
  const expansion = SENT_CONTEXT_EXPANSIONS[record.kind] as Expansion<KnownComposerContextKind>;
  const label = record.label.trim();
  const sections = expansion
    .sections(record)
    .filter(
      (entry): entry is SentContextSection =>
        entry !== null && !(entry.label !== null && entry.text === label),
    );
  if (sections.length === 0) return null;
  return {
    contextId: record.contextId,
    kind: record.kind,
    label: record.label,
    display: expansion.display,
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
