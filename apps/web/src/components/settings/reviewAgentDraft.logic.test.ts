import { describe, expect, it } from "vite-plus/test";

import {
  newReviewDraft,
  reviewAgentFromDraft,
  reviewDraftFromAgent,
  reviewModelKey,
  withKind,
} from "./reviewAgentDraft.logic";

describe("review agent drafts", () => {
  it("round-trips a stored review agent unchanged", () => {
    const agent = {
      type: "review" as const,
      kind: "context-review" as const,
      rules: [{ id: "r1", title: "Use Sparkwing", instructions: "Land through Sparkwing." }],
      instructionFiles: ["~/AGENTS.md", "/etc/standards.md"],
      includeProjectAgents: true,
      targets: {
        state: "closed" as const,
        threadIds: ["thread:a", "thread:b"] as never,
        includeChildren: false,
        minAgeMs: 0,
        updatedWithinMs: 3_600_000,
      },
      delivery: "alerts" as const,
    };
    expect(reviewAgentFromDraft(reviewDraftFromAgent(agent))).toEqual({ agent });
  });

  it("refuses rules without text and relative instruction files", () => {
    const draft = newReviewDraft("r1");
    expect(reviewAgentFromDraft({ ...draft, rules: [] })).toEqual({
      error: "Add between 1 and 32 rules.",
    });
    expect(
      reviewAgentFromDraft({ ...draft, rules: [{ id: "r1", title: " ", instructions: "x" }] }),
    ).toEqual({ error: "Rule 1 needs a title.", field: "rule-title:r1" });
    expect(
      reviewAgentFromDraft({ ...draft, instructionFiles: "~/ok.md\ndocs/standards.md" }),
    ).toEqual({
      error: "Use an absolute or ~/ path for instruction file docs/standards.md.",
      field: "instruction-files",
    });
  });

  it("names the first incomplete rule field for focus", () => {
    const draft = newReviewDraft("r1");
    const second = { id: "r2", title: "", instructions: "" };
    expect(reviewAgentFromDraft({ ...draft, rules: [...draft.rules, second] })).toEqual({
      error: "Rule 2 needs a title.",
      field: "rule-title:r2",
    });
    expect(
      reviewAgentFromDraft({ ...draft, rules: [...draft.rules, { ...second, title: "T" }] }),
    ).toEqual({ error: "Rule 2 needs instructions.", field: "rule-instructions:r2" });
  });

  it("drops blank rules when the kind changes, keeping at least one", () => {
    const draft = newReviewDraft("r1");
    const blank = { id: "r2", title: " ", instructions: "" };
    expect(withKind({ ...draft, rules: [...draft.rules, blank] }, "context-review")).toEqual({
      ...draft,
      kind: "context-review",
    });
    expect(withKind({ ...draft, rules: [blank] }, "context-review").rules).toEqual([blank]);
  });

  it("starts a new review on a ready Claude Haiku", () => {
    const entry = (instanceId: string, driverKind: string, slugs: string[], isAvailable = true) =>
      ({
        instanceId,
        driverKind,
        enabled: true,
        isAvailable,
        models: slugs.map((slug) => ({ slug })),
      }) as never;
    expect(
      reviewModelKey([
        entry("codex", "codex", ["gpt-6"]),
        entry("claude-off", "claudeAgent", ["claude-haiku-4-5"], false),
        entry("claude", "claudeAgent", ["claude-opus-5-5", "claude-haiku-4-5"]),
      ]),
    ).toBe("claude:claude-haiku-4-5");
    expect(reviewModelKey([entry("claude", "claudeAgent", ["claude-opus-5-5"])])).toBeNull();
  });
});
