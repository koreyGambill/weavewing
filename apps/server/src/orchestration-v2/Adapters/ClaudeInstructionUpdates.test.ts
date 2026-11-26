import { describe, expect, it } from "vite-plus/test";

import { claudeSystemPromptAppend, claudeSystemPromptSections } from "./ClaudeAdapterV2.ts";
import {
  claudeInstructionRecord,
  claudeInstructionRecordBeforeNotices,
  claudeInstructionUpdate,
  type ClaudeAppendSection,
} from "./ClaudeInstructionUpdates.ts";

const tools = { hasT3Mcp: true, deviceTools: false, questionTools: true } as const;
const append = claudeSystemPromptAppend({ ...tools, launchAppend: ["Answer in French."] });
const sections = claudeSystemPromptSections({ ...tools, append });
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
        "<runtime_info>",
        "<pull_request_linking>",
        "## T3 Code orchestration",
        "## T3 Code QA",
        "### Visuals and preview",
        "## T3 Code questions",
        "Custom system prompt append",
      ]),
    );
    expect(named("## T3 Code orchestration").text).toContain("`list_read`");
  });
});

describe("claudeInstructionUpdate", () => {
  it("gives a section the session started without in full, and nothing else", () => {
    const update = claudeInstructionUpdate({
      record: claudeInstructionRecord(without("## T3 Code QA")),
      sections,
      cut: false,
    });
    expect(update.notice).toContain('<section name="## T3 Code QA" change="added">');
    expect(update.notice).toContain(named("## T3 Code QA").text.trim());
    expect(update.notice).not.toContain("## T3 Code orchestration");
    expect(update.notice).not.toContain("Answer in French.");
    expect(update.next).toEqual({
      start: claudeInstructionRecord(without("## T3 Code QA")).start,
      sections: claudeInstructionRecord(sections).sections,
    });
  });

  it("gives a changed section in its new form and names removed ones", () => {
    const old = replacing("## T3 Code QA", "\n\n## T3 Code QA\n\nOLD-QA-RULE");
    const update = claudeInstructionUpdate({
      record: claudeInstructionRecord([...old, { name: "## Retired", text: "\n\n## Retired" }]),
      sections,
      cut: false,
    });
    expect(update.notice).toContain('<section name="## T3 Code QA" change="replaced">');
    expect(update.notice).not.toContain("OLD-QA-RULE");
    expect(update.notice).toContain("These sections no longer apply: ## Retired");
  });

  it("sends nothing to a session that already has the current sections", () => {
    const record = claudeInstructionRecord(sections);
    expect(claudeInstructionUpdate({ record, sections, cut: false })).toEqual({
      notice: null,
      next: record,
    });
  });

  it("gives a session with no record every current section and an unknown start", () => {
    const update = claudeInstructionUpdate({ record: undefined, sections, cut: false });
    expect(update.notice).toContain("cannot tell which version");
    for (const section of sections)
      expect(update.notice).toContain(`<section name="${section.name}">`);
    expect(update.next.start).toBeNull();
  });

  it("drops accepted notices when the session resumes at an earlier point", () => {
    const record = {
      ...claudeInstructionRecord(without("## T3 Code QA")),
      sections: claudeInstructionRecord(sections).sections,
    };
    expect(claudeInstructionUpdate({ record, sections, cut: false }).notice).toBeNull();
    expect(claudeInstructionUpdate({ record, sections, cut: true }).notice).toContain(
      '<section name="## T3 Code QA" change="added">',
    );
  });

  it("treats an earlier point of a compacted session as unknown", () => {
    const record = claudeInstructionRecord(sections, { compacted: true });
    expect(claudeInstructionRecordBeforeNotices(record)).toBeUndefined();
    const update = claudeInstructionUpdate({ record, sections, cut: true });
    expect(update.notice).toContain("cannot tell which version");
    expect(update.next.start).toBeNull();
  });
});
