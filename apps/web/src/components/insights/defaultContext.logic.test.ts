import type { DefaultContextItem, DefaultContextPreview } from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultContextSummary,
  fileTree,
  homeOf,
  shortenPath,
  splitPath,
} from "./defaultContext.logic";

const item = (overrides: Partial<DefaultContextItem>): DefaultContextItem => ({
  id: overrides.label ?? "x",
  category: "t3",
  label: "x",
  source: "test",
  delivery: "every-turn",
  bytes: 0,
  estimatedTokens: 0,
  counted: true,
  readable: true,
  ...overrides,
});

const preview = (
  items: ReadonlyArray<DefaultContextItem>,
  lastTurn?: { readonly injectedBytes: number },
): DefaultContextPreview => ({
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  driver: "claudeAgent",
  model: "opus",
  cwd: null,
  support: "exact",
  filesSupported: true,
  notes: [],
  items,
  notVisible: [],
  lastTurn:
    lastTurn === undefined
      ? null
      : { capturedAt: "2026-11-13T00:00:00.000Z", model: "opus", reportsFiles: true, ...lastTurn },
  estimateMethod: "",
});

describe("defaultContextSummary", () => {
  it("totals only counted items and orders categories and groups", () => {
    const summary = defaultContextSummary(
      preview(
        [
          item({ label: "tool", category: "tools", bytes: 400, estimatedTokens: 100 }),
          item({
            label: "deferred",
            category: "tools",
            bytes: 4000,
            estimatedTokens: 1000,
            counted: false,
          }),
          item({
            label: "CLAUDE.md",
            category: "files",
            bytes: 400,
            estimatedTokens: 100,
            status: "not-loaded",
          }),
          item({ label: "runtime", bytes: 800, estimatedTokens: 200 }),
          item({ label: "AGENTS.md", category: "files", bytes: 9, status: "unexpected" }),
          item({ label: "append", category: "custom", bytes: 9, counted: false }),
          item({ label: "tdd", category: "skills", bytes: 40, estimatedTokens: 10 }),
        ],
        { injectedBytes: 800 },
      ),
    );
    expect(summary).toMatchObject({
      bytes: 1649,
      tokens: 410,
      attention: 2,
      injectedDiff: 9,
    });
    expect(summary.categories.map((category) => [category.category, category.share])).toEqual([
      ["t3", 800 / 1649],
      ["files", 409 / 1649],
      ["skills", 40 / 1649],
      ["tools", 400 / 1649],
    ]);
    expect(summary.groups.map((group) => [group.category, group.items.length])).toEqual([
      ["t3", 1],
      ["files", 2],
      ["skills", 1],
      ["tools", 2],
      ["custom", 1],
    ]);
  });
});

describe("fileTree", () => {
  it("nests linked files under their parent and keeps orphans visible", () => {
    const { roots, childrenOf } = fileTree([
      item({ label: "CLAUDE.md" }),
      item({ label: "a.md", parentId: "CLAUDE.md" }),
      item({ label: "b.md", parentId: "a.md" }),
      item({ label: "orphan.md", parentId: "gone.md" }),
    ]);
    expect(roots.map((entry) => entry.label)).toEqual(["CLAUDE.md", "orphan.md"]);
    expect(childrenOf.get("CLAUDE.md")?.map((entry) => entry.label)).toEqual(["a.md"]);
    expect(childrenOf.get("a.md")?.map((entry) => entry.label)).toEqual(["b.md"]);
  });
});

describe("paths", () => {
  it("collapses the home folder only on a whole path segment", () => {
    const home = homeOf(["/srv/x", "/home/korey/code/AGENTS.md"]);
    expect(home).toBe("/home/korey");
    expect(shortenPath("/home/korey/.claude/CLAUDE.md", home)).toBe("~/.claude/CLAUDE.md");
    expect(shortenPath("/home/koreyx/CLAUDE.md", home)).toBe("/home/koreyx/CLAUDE.md");
    expect(shortenPath("/etc/claude-code/CLAUDE.md", null)).toBe("/etc/claude-code/CLAUDE.md");
    expect(splitPath("~/.config/wing/AGENT_BOOTSTRAP.md")).toEqual({
      directory: "~/.config/wing/",
      name: "AGENT_BOOTSTRAP.md",
    });
  });
});
