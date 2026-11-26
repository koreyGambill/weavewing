import { describe, expect, it } from "vite-plus/test";

import { claudeSystemPromptAppend, claudeSystemPromptSections } from "./ClaudeAdapterV2.ts";
import {
  CLAUDE_INSTRUCTION_NOTICE_MARKER,
  claudeAppendSections,
  claudeInstructionRecord,
  claudeInstructionUpdate,
  claudeSectionDigest,
  withoutClaudeInstructionNotice,
  type ClaudeAppendSection,
} from "./ClaudeInstructionUpdates.ts";

const tools = { hasT3Mcp: true, deviceTools: false, questionTools: true } as const;
const append = claudeSystemPromptAppend({ ...tools, launchAppend: ["Answer in French."] });
const sections = claudeSystemPromptSections({ ...tools, append });
const QA = "t3:0:## T3 Code QA";
const named = (name: string) => {
  const section = sections.find((candidate) => candidate.name === name);
  if (section === undefined) throw new Error(`No section ${name}`);
  return section;
};
const without = (name: string) => sections.filter((section) => section.name !== name);
const replacing = (name: string, text: string): ReadonlyArray<ClaudeAppendSection> =>
  sections.map((section) => (section.name === name ? { name, text } : section));

describe("claudeAppendSections", () => {
  it("cuts the append into named sections that add up to it exactly", () => {
    expect(sections.map((section) => section.text).join("")).toBe(append);
    expect(sections.map((section) => section.name)).toEqual(
      expect.arrayContaining([
        "t3:0:<runtime_info>",
        "t3:0:<pull_request_linking>",
        "t3:0:## T3 Code orchestration",
        QA,
        "t3:0:### Visuals and preview",
        "t3:0:## T3 Code questions",
        "custom",
      ]),
    );
    expect(named("t3:0:## T3 Code orchestration").text).toContain("`list_read`");
  });

  it("gives repeated headings identities that no heading text can collide with", () => {
    const text = "## Name\n\na\n\n## Name\n\nb\n\n## Name (2)\n\nc\n\n## Name#1\n\nd";
    const names = claudeAppendSections(text, text).map((section) => section.name);
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual(["t3:0:## Name", "t3:1:## Name", "t3:0:## Name (2)", "t3:0:## Name#1"]);
  });
});

describe("claudeSectionDigest", () => {
  it("ignores the blank lines between sections but not indentation", () => {
    expect(claudeSectionDigest("\n\n## X\n\nbody")).toBe(claudeSectionDigest("## X\n\nbody\n\n"));
    expect(claudeSectionDigest("\n\n  indented rule")).not.toBe(
      claudeSectionDigest("\n\nindented rule"),
    );
  });
});

describe("claudeInstructionUpdate", () => {
  it("gives a section the session started without in full, and nothing else", () => {
    const update = claudeInstructionUpdate({
      record: claudeInstructionRecord(without(QA)),
      sections,
      cut: false,
    });
    expect(update.notice?.split("\n")[1]).toBe(CLAUDE_INSTRUCTION_NOTICE_MARKER);
    expect(update.notice).toContain('<section name="## T3 Code QA" change="added">');
    expect(update.notice).toContain(named(QA).text.trim());
    expect(update.notice).not.toContain("## T3 Code orchestration");
    expect(update.notice).not.toContain("Answer in French.");
    expect(update.next).toEqual({
      start: claudeInstructionRecord(without(QA)).start,
      sections: claudeInstructionRecord(sections).sections,
    });
  });

  it("gives a changed section in its new form and names removed ones", () => {
    const old = replacing(QA, "\n\n## T3 Code QA\n\nOLD-QA-RULE");
    const update = claudeInstructionUpdate({
      record: claudeInstructionRecord([
        ...old,
        { name: "t3:0:## Retired", text: "\n\n## Retired" },
      ]),
      sections,
      cut: false,
    });
    expect(update.notice).toContain('<section name="## T3 Code QA" change="replaced">');
    expect(update.notice).not.toContain("OLD-QA-RULE");
    expect(update.notice).toContain("These sections no longer apply: ## Retired");
  });

  it("delivers a changed indentation as it is, so the digest and the body agree", () => {
    // A launch-argument append whose first line is indented, then the same append unindented.
    const indented = claudeAppendSections("T3 text\n\n  - keep two spaces", "T3 text");
    const flat = claudeAppendSections("T3 text\n\n- keep two spaces", "T3 text");
    const update = claudeInstructionUpdate({
      record: claudeInstructionRecord(flat),
      sections: indented,
      cut: false,
    });
    expect(update.notice).toContain('change="replaced">\n  - keep two spaces\n</section>');
  });

  it("sends nothing to a session that already has the current sections", () => {
    const record = claudeInstructionRecord(sections);
    expect(claudeInstructionUpdate({ record, sections, cut: false })).toEqual({
      notice: null,
      next: record,
    });
  });

  it("gives a session with no record the complete current set and retires the rest", () => {
    const update = claudeInstructionUpdate({ record: undefined, sections, cut: false });
    expect(update.notice).toContain("here is the complete current set");
    expect(update.notice).toContain(
      "any section of T3 Code's earlier instructions that is not repeated here no longer applies",
    );
    expect(update.notice).toContain('<section name="## T3 Code QA">');
    expect(update.notice).toContain('<section name="Custom system prompt append">');
    expect(update.next.start).toBeNull();
  });

  it("treats a cut between an added and a removed section as unknown", () => {
    // Started without Extra, accepted a notice adding it, then one removing it: the head matches
    // the start, but a point between the notices still holds Extra.
    const record = claudeInstructionRecord(sections);
    expect(claudeInstructionUpdate({ record, sections, cut: false }).notice).toBeNull();
    const cut = claudeInstructionUpdate({ record, sections, cut: true });
    expect(cut.notice).toContain("here is the complete current set");
    expect(cut.notice).toContain("is not repeated here no longer applies");
    expect(cut.next).toEqual({ start: null, sections: record.sections });
  });
});

describe("withoutClaudeInstructionNotice", () => {
  const notice = claudeInstructionUpdate({ record: undefined, sections, cut: false }).notice!;

  it("removes the notice block and keeps what the user wrote after it", () => {
    expect(withoutClaudeInstructionNotice(notice)).toBe("");
    expect(withoutClaudeInstructionNotice(`${notice}\n\nFix the toast.`)).toBe("Fix the toast.");
  });

  it("keeps text that only mentions the marker or uses a reminder of its own", () => {
    const mention = `Why does ${CLAUDE_INSTRUCTION_NOTICE_MARKER} show up in my logs?`;
    const reminder = "<system-reminder>\nRun the tests first.\n</system-reminder>";
    expect(withoutClaudeInstructionNotice(mention)).toBe(mention);
    expect(withoutClaudeInstructionNotice(reminder)).toBe(reminder);
  });
});
