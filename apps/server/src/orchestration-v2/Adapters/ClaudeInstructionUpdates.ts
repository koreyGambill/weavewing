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
  /** Unique within an append: the kind, the heading's occurrence and the heading itself. */
  readonly name: string;
  readonly text: string;
}

export interface ClaudeInstructionUpdate {
  /** The notice to put ahead of the next normal turn, or null when the session is current. */
  readonly notice: string | null;
  /** The record once the session has the notice (or at once, when there is none). */
  readonly next: ClaudeInstructionRecord;
}

/** The first line inside every notice; only this mechanism writes it, so import can strip it. */
export const CLAUDE_INSTRUCTION_NOTICE_MARKER = "[t3-code:instruction-update]";
const NOTICE_OPENING = `<system-reminder>\n${CLAUDE_INSTRUCTION_NOTICE_MARKER}\n`;
const NOTICE_CLOSING = "\n</system-reminder>";

/** The name of the section holding the user's own launch-argument append. */
export const CLAUDE_CUSTOM_APPEND_SECTION = "custom";

/** A section's text without the blank lines that separate it from its neighbours. */
const sectionBody = (text: string) => text.replace(/^\n+/, "").replace(/\n+$/, "");

/** Covers exactly the body a notice delivers, so a change the digest sees is a change sent. */
export const claudeSectionDigest = (text: string) =>
  NodeCrypto.createHash("sha256").update(sectionBody(text)).digest("hex").slice(0, 12);

// A section starts at a line opening with a level-2 or level-3 heading or a top-level XML tag.
const SECTION_BOUNDARY = /\n(?=#{2,3} |<[a-z_]+>)/g;

function sectionHeading(text: string): string {
  const firstLine = text.trimStart().split("\n", 1)[0]?.trim() ?? "";
  return /^<([a-z_]+)>/.exec(firstLine)?.[0] ?? firstLine;
}

/** The heading a section is shown under; a repeated heading names its occurrence. */
function displayName(name: string): string {
  if (name === CLAUDE_CUSTOM_APPEND_SECTION) return "Custom system prompt append";
  const match = /^t3:(\d+):([\s\S]*)$/.exec(name);
  if (match === null) return name;
  const occurrence = Number(match[1]);
  return occurrence === 0 ? match[2]! : `${match[2]} (occurrence ${occurrence + 1})`;
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
    const heading = sectionHeading(chunk);
    const occurrence = used.get(heading) ?? 0;
    used.set(heading, occurrence + 1);
    sections.push({ name: `t3:${occurrence}:${heading}`, text: carried + chunk });
    carried = "";
  }
  const custom = append.slice(t3Part.length);
  if (carried) {
    const last = sections.pop();
    sections.push(
      last === undefined
        ? { name: "separators", text: carried }
        : { ...last, text: last.text + carried },
    );
  }
  if (custom) sections.push({ name: CLAUDE_CUSTOM_APPEND_SECTION, text: custom });
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

/** The heading a section is listed under in the context breakdown. */
export function claudeSectionLabel(name: string): string {
  return displayName(name);
}

const NOT_FROM_USER =
  "This came from T3 Code, not from the user, so do not mention it to the user unless they ask.";

/** The record of a session whose instructions are an unknown mix, such as after a rollback. */
export const CLAUDE_UNKNOWN_INSTRUCTIONS: ClaudeInstructionRecord = {
  start: null,
  sections: [],
  unknown: true,
};

/** Delivery is assumed once this many completed prompts carried a notice nobody acknowledged. */
const CARRIED_PROMPTS_BEFORE_ASSUMED = 2;

/** Identifies a notice's text, so a count of prompts that carried it survives restarts. */
const claudeNoticeDigest = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * Counts a completed prompt that carried `update`'s notice without an acknowledgment. Returns the
 * record to store: the delivered record once the bound is reached, otherwise the count.
 */
export function claudeInstructionNoticeCarried(
  record: ClaudeInstructionRecord | undefined,
  update: ClaudeInstructionUpdate,
): ClaudeInstructionRecord {
  if (update.notice === null) return update.next;
  const notice = claudeNoticeDigest(update.notice);
  const carried = (record?.owed?.notice === notice ? record.owed.carried : 0) + 1;
  if (carried >= CARRIED_PROMPTS_BEFORE_ASSUMED) return update.next;
  const { owed: _owed, ...base } = record ?? CLAUDE_UNKNOWN_INSTRUCTIONS;
  return { ...base, owed: { notice, carried } };
}

const sectionBlock = (section: ClaudeAppendSection, change?: "added" | "replaced") =>
  `<section name="${displayName(section.name)}"${change === undefined ? "" : ` change="${change}"`}>\n${sectionBody(section.text)}\n</section>`;

const notice = (lines: ReadonlyArray<string>) =>
  `${NOTICE_OPENING}${lines.join("\n")}${NOTICE_CLOSING}`;

/**
 * Compares a resumed session's record with the current sections. `cut` means the session resumes
 * at a point other than its head, where it may hold any mix of the notices it accepted, so its
 * instructions are unknown.
 */
export function claudeInstructionUpdate(input: {
  readonly record: ClaudeInstructionRecord | undefined;
  readonly sections: ReadonlyArray<ClaudeAppendSection>;
  readonly cut: boolean;
}): ClaudeInstructionUpdate {
  const { sections } = input;
  const record = input.cut || input.record?.unknown === true ? undefined : input.record;
  const current = claudeInstructionRecord(sections).sections;
  const next = {
    start: record?.start ?? null,
    sections: current,
    ...(record?.compacted === true ? { compacted: true } : {}),
  };
  if (record === undefined) {
    return {
      notice: notice([
        `T3 Code cannot tell which version of its instructions this session has, so here is the complete current set. Apply these sections from now on; each replaces its earlier copy, and any section of T3 Code's earlier instructions that is not repeated here no longer applies. ${NOT_FROM_USER}`,
        "",
        sections.map((section) => sectionBlock(section)).join("\n\n"),
      ]),
      next,
    };
  }
  const recorded = new Map(record.sections.map((section) => [section.name, section.digest]));
  const changes = sections.flatMap((section, index) => {
    const digest = recorded.get(section.name);
    if (digest === current[index]?.digest) return [];
    return [sectionBlock(section, digest === undefined ? "added" : "replaced")];
  });
  const names = new Set(sections.map((section) => section.name));
  const removed = record.sections.filter((section) => !names.has(section.name));
  if (changes.length === 0 && removed.length === 0) return { notice: null, next };
  return {
    notice: notice([
      `T3 Code's instructions changed after this session started. Apply the sections below from now on; each replaces its earlier copy, and the rest of T3 Code's instructions still apply. ${NOT_FROM_USER}`,
      ...(changes.length === 0 ? [] : ["", changes.join("\n\n")]),
      ...(removed.length === 0
        ? []
        : [
            "",
            `These sections no longer apply: ${removed.map((section) => displayName(section.name)).join("; ")}`,
          ]),
    ]),
    next,
  };
}

/**
 * Removes a T3 instruction notice that opens the text, from its marker line through its own
 * closing tag, and keeps everything after it. When that span cannot be bounded exactly, such as
 * when another reminder opens inside it, the text is returned unchanged: showing a notice is
 * better than losing what the user wrote.
 */
export function withoutClaudeInstructionNotice(text: string): string {
  if (!text.startsWith(NOTICE_OPENING)) return text;
  const end = text.indexOf(NOTICE_CLOSING, NOTICE_OPENING.length);
  if (end === -1) return text;
  if (text.slice(NOTICE_OPENING.length, end).includes("<system-reminder>")) return text;
  const after = end + NOTICE_CLOSING.length;
  if (after < text.length && text[after] !== "\n") return text;
  return text.slice(after).replace(/^\n+/, "");
}
