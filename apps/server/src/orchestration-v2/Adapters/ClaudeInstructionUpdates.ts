// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2ProviderThreadNativeMetadata } from "@t3tools/contracts";

/**
 * What a Claude session holds of T3's appended system prompt. Claude Code replays a session's
 * first system prompt on every resume, so T3 tells a resumed session about changed sections once,
 * in its first turn, and records what it accepted.
 */
export type ClaudeInstructionRecord = NonNullable<
  OrchestrationV2ProviderThreadNativeMetadata["claudeInstructions"]
>;

export interface ClaudeAppendSection {
  readonly name: string;
  readonly text: string;
}

export interface ClaudeInstructionUpdate {
  /** The notice to put ahead of the next normal turn, or null when the session is current. */
  readonly notice: string | null;
  /** The record once the session has the notice (or at once, when there is none). */
  readonly next: ClaudeInstructionRecord;
}

const CUSTOM_APPEND_SECTION = "Custom system prompt append";

export const claudeSectionDigest = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

// A section starts at a line opening with a level-2 or level-3 heading or a top-level XML tag.
const SECTION_BOUNDARY = /\n(?=#{2,3} |<[a-z_]+>)/g;

function sectionName(text: string): string {
  const firstLine = text.trimStart().split("\n", 1)[0]?.trim() ?? "";
  return /^<([a-z_]+)>/.exec(firstLine)?.[0] ?? firstLine;
}

/**
 * Cuts the append into named sections whose texts concatenate to it exactly. T3's text is cut at
 * its headings and tags; the user's own launch-argument append stays one section.
 */
export function claudeAppendSections(
  append: string,
  t3Text: string,
): ReadonlyArray<ClaudeAppendSection> {
  const t3Part = append.startsWith(t3Text) ? t3Text : append;
  const starts = [0, ...[...t3Part.matchAll(SECTION_BOUNDARY)].map((match) => match.index + 1)];
  const chunks = starts.map((start, index) => t3Part.slice(start, starts[index + 1]));
  const sections: ClaudeAppendSection[] = [];
  let carried = "";
  const used = new Map<string, number>();
  for (const chunk of chunks) {
    if (chunk.trim() === "") {
      carried += chunk;
      continue;
    }
    const base = sectionName(chunk);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    sections.push({ name: seen === 0 ? base : `${base} (${seen + 1})`, text: carried + chunk });
    carried = "";
  }
  const custom = append.slice(t3Part.length);
  if (carried) {
    const last = sections.pop();
    sections.push(
      last === undefined
        ? { name: "<separators>", text: carried }
        : { ...last, text: last.text + carried },
    );
  }
  if (custom) sections.push({ name: CUSTOM_APPEND_SECTION, text: custom });
  return sections;
}

/** The record of a session that started with these sections. */
export function claudeInstructionRecord(
  sections: ReadonlyArray<ClaudeAppendSection>,
  options?: { readonly compacted?: boolean },
): ClaudeInstructionRecord {
  return {
    start: sections.map((section) => ({
      name: section.name,
      digest: claudeSectionDigest(section.text),
      bytes: Buffer.byteLength(section.text, "utf8"),
    })),
    sections: sections.map((section) => ({
      name: section.name,
      digest: claudeSectionDigest(section.text),
    })),
    ...(options?.compacted === true ? { compacted: true } : {}),
  };
}

export function sameClaudeInstructionRecord(
  left: ClaudeInstructionRecord | undefined,
  right: ClaudeInstructionRecord | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const NOT_FROM_USER =
  "This is ambient context from T3 Code, not a message from the user; do not mention it unless the user asks.";

const sectionBlock = (section: ClaudeAppendSection, change?: "added" | "replaced") =>
  `<section name="${section.name}"${change === undefined ? "" : ` change="${change}"`}>\n${section.text.trim()}\n</section>`;

/**
 * What a session resumed or forked at an earlier point holds: its start append, because the
 * notices it accepted may come after that point. Compaction replaces the start append, so a
 * compacted session's earlier points are unknown.
 */
export function claudeInstructionRecordBeforeNotices(
  record: ClaudeInstructionRecord | undefined,
): ClaudeInstructionRecord | undefined {
  if (record === undefined || record.start === null || record.compacted === true) return undefined;
  return {
    start: record.start,
    sections: record.start.map(({ name, digest }) => ({ name, digest })),
  };
}

/**
 * Compares a resumed session's record with the current sections. `cut` means the session resumes
 * at an earlier point of its conversation.
 */
export function claudeInstructionUpdate(input: {
  readonly record: ClaudeInstructionRecord | undefined;
  readonly sections: ReadonlyArray<ClaudeAppendSection>;
  readonly cut: boolean;
}): ClaudeInstructionUpdate {
  const { sections } = input;
  const record = input.cut ? claudeInstructionRecordBeforeNotices(input.record) : input.record;
  const current = claudeInstructionRecord(sections).sections;
  const next = {
    start: record?.start ?? null,
    sections: current,
    ...(record?.compacted === true ? { compacted: true } : {}),
  };
  if (record === undefined) {
    return {
      notice: [
        "<system-reminder>",
        `T3 Code cannot tell which version of its instructions this session started with, so here is the current version in full. Each section replaces its earlier copy, if any. ${NOT_FROM_USER}`,
        "",
        sections.map((section) => sectionBlock(section)).join("\n\n"),
        "</system-reminder>",
      ].join("\n"),
      next,
    };
  }
  const baseline = record.sections;
  const recorded = new Map(baseline.map((section) => [section.name, section.digest]));
  const changes = sections.flatMap((section, index) => {
    const digest = recorded.get(section.name);
    if (digest === current[index]?.digest) return [];
    return [sectionBlock(section, digest === undefined ? "added" : "replaced")];
  });
  const names = new Set(sections.map((section) => section.name));
  const removed = baseline.filter((section) => !names.has(section.name));
  if (changes.length === 0 && removed.length === 0) return { notice: null, next };
  return {
    notice: [
      "<system-reminder>",
      `T3 Code's instructions changed after this session started. The sections below differ from their earlier copies: each replaces its earlier copy, and the rest of T3 Code's instructions still apply. ${NOT_FROM_USER}`,
      ...(changes.length === 0 ? [] : ["", changes.join("\n\n")]),
      ...(removed.length === 0
        ? []
        : [
            "",
            `These sections no longer apply: ${removed.map((section) => section.name).join("; ")}`,
          ]),
      "</system-reminder>",
    ].join("\n"),
    next,
  };
}
